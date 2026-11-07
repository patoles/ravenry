// The window, layout A: the board in the sidebar (Needs you first), the
// terminal in the middle, the session panel on the right. The tab strip
// holds only the open session, plain shells and pinned sessions, so it
// never repeats the sidebar.
//
// Plain shells are the daemons' panes labelled `ravenry.kind: shell`, so
// they are found again on every daemon after a restart; window.json keeps
// only the pinned sessions, the tabs' order and the panel's state.
//
// Checkpoints (an agent waits to be answered, approved or given a secret)
// come from the daemons this window holds and from the hub, and show as a
// mark on the session's row, a dot on its tab and a card at the top of
// the panel (cards.ts).
//
// The rows under the sessions are pages (pages.ts): page files the hub
// reads. A page opens in the middle and right columns; picking a session
// brings the terminal back.

import '@xterm/xterm/css/xterm.css';
import './app.css';
import './phase2.css';
import type { AgentStatus, Checkpoint, DaemonEvent, InputRecord, Pane, RavenryClient, Source } from '@ravenry/client';
import { api } from './api.ts';
import type { AppConfig, AssistantInfo, FolderPick, HubStatus } from './api.ts';
import { cardFor, cardKey, clearHiddenSecrets, focusCard, NotPerson, onCardChange, pruneCards } from './cards.ts';
import type { CardCtx, Reply } from './cards.ts';
import { Checkpoints, daemonAnswer, driveVerb, hubAnswer, isOpen, markOf, timeOf } from './checkpoints.ts';
import type { HubCheckpoint, Known } from './checkpoints.ts';
import { Daemons } from './daemons.ts';
import { h, replace, svg } from './dom.ts';
import * as I from './icons.ts';
import {
  ago, arrivals, assistantName, board, secondLine, clock, findSession, isEmpty, machineOf, memoryLine, paneOf, rekeyed, sessionGroup, sessionKey, sessionOfPane, tokens,
} from './model.ts';
import type { Group, HubProject, HubSession, HubState, RowMark } from './model.ts';
import { Machines, MACHINES_ICON } from './machines.ts';
import { initNpmSwitch, npmChosen, npmTakesCentre, renderNpmCentre, renderNpmPointer, setBoardLive } from './npmswitch.ts';
import type { MachineView } from './machines.ts';
import { Pages } from './pages.ts';
import type { NavRow } from './pages.ts';
import { TerminalView, THEME } from './terminal.ts';
import { PaneStore } from './panes.ts';
import { TerminalMarks } from './marks.ts';
import { leaseStrip, leaseWords, openedLine, panesItUses, typedHere, whoCanType } from './panepanel.ts';
import type { PaneCtx, Who } from './panepanel.ts';
import { Filmstrip } from './filmstrip.ts';
import { Decisions } from './decisions.ts';
import { Picker } from './picker.ts';
import { Files } from './files.ts';
import { Review } from './review.ts';
import { sayPathOn } from '../../../../hub/public/homepath.mjs';
import { PhoneCard } from './phonecard.ts';

// ---------------------------------------------------------------- state

/** The label that marks a pane as one of the app's plain shells (PROTOCOL.md section 3). */
const SHELL_LABEL = { 'ravenry.kind': 'shell' } as const;

interface ShellTab {
  id: string; kind: 'shell'; socket: string; pane: string;
  /** The assistant the first launch started in it (its `ravenry.agent` label). */
  agent?: string | null;
  title?: string; name?: string; cwd?: string; command?: string[]; cols?: number; rows?: number; createdAt?: string;
  /** An agent's own pane (a dev server it started): the pane its agent runs in. */
  owner?: string;
  /** The agent running in it, from the daemon's status channel. */
  status?: AgentStatus | null;
  /** It printed while it was not on screen. */
  activity?: boolean;
}
/** A session's tab; `pane` for one just started, until the hub lists it. */
interface SessionTab { id: string; kind: 'session'; key: string; pane?: string; /** Its name when last on the board. */ name?: string }
type Tab = ShellTab | SessionTab;
type View =
  | { kind: 'tab'; id: string }
  /** A session picked in the sidebar; `pane` until the hub lists a session just started. */
  | { kind: 'session'; key: string; pane?: string }
  /** A pane of no tab: the one an approved command ran in. */
  | { kind: 'pane'; socket: string; pane: string; name: string }
  /** A page (pages.ts), in the middle and right columns. */
  | { kind: 'page'; key: string }
  /** The Machines page (machines.ts), in the middle and right columns. */
  | { kind: 'machines' }
  /** The Decisions page (decisions.ts). */
  | { kind: 'decisions' }
  /** A pick, side by side (picker.ts); `back` is where Close goes. */
  | { kind: 'picker'; cp: string; back: View }
  /** Who changed what in a project (files.ts). */
  | { kind: 'grid'; project: string; back: View }
  /** A worktree session's review, beside its terminal (review.ts). */
  | { kind: 'review'; key: string }
  | { kind: 'start' }
  | { kind: 'none' };

/** Below this width the session panel folds away by itself. */
const PANEL_FOLD_WIDTH = 1180;

const S = {
  config: null as AppConfig | null,
  hub: null as HubState | null,
  hubStatus: null as HubStatus | null,
  tabs: [] as Tab[],
  view: { kind: 'none' } as View,
  /** The user's own choice for the panel on a wide window; null follows the window. */
  panelPref: null as 'open' | 'closed' | null,
  /** The panel shown over the terminal (a narrow window, or one that arrived). */
  overlay: false,
  /**
   * What the panel shows when it differs from the middle: a session key, a
   * shell tab ("tab:<id>") or a checkpoint of no known pane ("cp:<id>").
   */
  panelKey: null as string | null,
  restored: false,
  daemonError: null as string | null,
  cps: new Checkpoints(),
  /**
   * Daemons that do not take this window as the person (hello.person is
   * false: it was started from inside a pane), and whether the hub refused
   * it (403). Their checkpoints show, but cannot be answered from here.
   */
  notPerson: new Set<string>(),
  hubRefused: false,
  /** A checkpoint whose card gets the keyboard after the next render. */
  focusCp: null as string | null,
  start: { folders: [] as FolderPick[], root: null as string | null, folder: null as string | null, assistants: [] as AssistantInfo[], assistant: null as string | null, busy: false, error: null as string | null, inFolder: false },
  /** The first-launch offer to set up the assistants' hooks. */
  hooks: { asked: false, offer: null as null | { files: string[]; names: string[] }, busy: false, error: null as string | null, checked: false },
};

const $ = (id: string) => document.getElementById(id)!;
let term: TerminalView;
let daemons: Daemons;
let pages: Pages;
let machinesView: Machines;
let film: Filmstrip;
let decisions: Decisions;
let picker: Picker;
let files: Files;
let review: Review;
/** The machines a toast already said were older or would not talk, by name and version. */
const toldMachines = new Set<string>();
/** The project of the session last shown, for a page's Ask Claude to fix. */
let lastSessionProject: string | null = null;

// ---------------------------------------------------------------- helpers

const isMac = () => S.config?.platform === 'darwin';
const shortcut = (k: string) => (isMac() ? `⌘${k}` : `Ctrl+Shift+${k}`);
const wide = () => window.innerWidth >= PANEL_FOLD_WIDTH;
const base = (p?: string) => (p ? p.replace(/\/+$/, '').split('/').pop() || p : '');
const now = () => Date.now();
// The phone button's card (phonecard.ts): pair the Ravenry app, phone access, devices.
const phoneCard = new PhoneCard({ call: (method, p, body) => api().hubCall(method, p, body), toast: (text) => toast(text), now });
// A folder said against the home of the machine it is on (hub/public/
// homepath.mjs): this computer's from the app, a machine's from the hub.
const tilde = (p?: string, machine?: string | null) => {
  if (!p) return '~';
  return sayPathOn(p, machine, { ...(S.hub?.homes || {}), ...(S.config?.home ? { '': S.config.home } : {}) });
};

// ---------------------------------------------------------------- who drives a pane (6, 19)

const store = new PaneStore();
let marks: TerminalMarks;

/** Who a Source is, as people know it: "Claude" in "Tilting the hull", "You". */
function sourceOf(src: Source | null | undefined): Who {
  if (!src || src.kind === 'person') return { who: 'You', where: null, cls: 'you' };
  if (src.kind === 'agent' && src.pane) {
    const f = sessionOfPane(S.hub, src.pane);
    const k = store.get(src.pane);
    const kind = f?.session.assistant || k?.pane.agent?.assistant || k?.pane.labels?.['ravenry.agent'] || null;
    const who = assistantName(kind) || 'An agent';
    const t = S.tabs.find((x): x is ShellTab => x.kind === 'shell' && x.pane === src.pane);
    const where = f ? f.session.topic || f.project.name : t ? tabLabel(t).name : k?.pane.name || null;
    return { who, where: where && where !== who ? where : null, cls: kind === 'claude' || kind === 'codex' ? kind : 'other' };
  }
  return { who: src.client || 'A program', where: null, cls: 'other' };
}

/** A pane as the tabs name it: "dev server". */
function paneNameOf(pane: string): string {
  const t = S.tabs.find((x): x is ShellTab => x.kind === 'shell' && x.pane === pane);
  if (t) return tabLabel(t).name;
  const f = sessionOfPane(S.hub, pane);
  if (f) return f.session.topic || f.project.name;
  const k = store.get(pane);
  return k?.pane.name || k?.pane.title || (k?.pane.command || [])[0]?.split('/').pop() || 'a pane';
}

/** The drive a person answered that let this input through: "You let it, once, at 17:41". */
function letBy(pane: string, r: InputRecord): { once: boolean; at: string } | null {
  if (r.source.kind !== 'agent') return null;
  const t = Date.parse(r.at);
  let best: { once: boolean; at: string; d: number } | null = null;
  for (const k of S.cps.items.values()) {
    const cp = k.cp;
    const a = cp.answer;
    if (cp.kind !== 'drive' || cp.drive?.pane !== pane || cp.drive.agent.pane !== r.source.pane || !a?.approved || !a.at) continue;
    const d = t - Date.parse(a.at);
    if (d < -2000 || d > (a.allow === 'session' ? 1e12 : 15000)) continue;
    if (!best || d < best.d) best = { once: a.allow !== 'session', at: a.at, d };
  }
  return best;
}

const paneCtx: PaneCtx = {
  store,
  now,
  source: sourceOf,
  paneName: paneNameOf,
  time: (iso) => (iso ? timeOf(iso, now()) : ''),
  agents: () => {
    const out: { pane: string; who: Who }[] = [];
    for (const p of S.hub?.projects || []) for (const s of p.sessions) {
      const pane = paneOf(s);
      if (pane && !machineOf(p, s) && store.get(pane)) out.push({ pane, who: sourceOf({ kind: 'agent', pane }) });
    }
    return out;
  },
  letNote: (pane, r) => { const l = letBy(pane, r); return l ? (l.once ? `You let it, once, at ${timeOf(l.at, now())}` : `You let it use the pane at ${timeOf(l.at, now())}`) : null; },
  toast: (text) => toast(text),
  rerender: () => render(),
};

let storeQueued = false;
store.onChange = (what) => {
  if (what.kind === 'input' && marks && term?.attached?.pane === what.pane) marks.show(store.inputsOf(what.pane));
  if (storeQueued) return;
  storeQueued = true;
  requestAnimationFrame(() => { storeQueued = false; renderSidebar(); renderTabs(); renderStrip(); if (panelVisible()) renderPanel(); });
};

/** The pane on screen in the middle, if any. */
function paneOnScreen(): string | null {
  return term?.attached?.pane || null;
}

/** A pick's picture, from the copy the hub keeps (hub/server/picks.mjs). */
function variantSrc(k: { cp: Checkpoint }, n: number): string | null {
  if (!S.config || !S.hubStatus?.reachable) return null;
  return `${S.config.hubUrl}/api/checkpoints/${encodeURIComponent(k.cp.id)}/variants/${n}`;
}

function openPicker(k: { cp: Checkpoint }): void {
  S.overlay = false;
  S.panelKey = null;
  const back = S.view.kind === 'picker' ? S.view.back : S.view;
  setView({ kind: 'picker', cp: k.cp.id, back });
}

/** 31 A: the decisions an agent read just before it asked. */
function checkedFor(k: { cp: Checkpoint }): { quote: string; when: string }[] | null {
  if (k.cp.kind !== 'ask' || !decisions) return null;
  const list = decisions.checkedBefore((k.cp as { projectId?: string | null }).projectId, k.cp.created_at);
  return list.map((d) => {
    const at = new Date(d.at);
    const today = at.toDateString() === new Date(now()).toDateString();
    return { quote: d.quote, when: today ? `today ${timeOf(d.at, now())}` : at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) };
  });
}

/** 19 A: the strip across the top of a lent pane. */
function renderStrip(): void {
  const el = $('lstrip');
  const pane = paneOnScreen();
  const strip = pane && !$('term').hidden ? leaseStrip(pane, paneCtx) : null;
  el.hidden = !strip;
  replace(el, strip);
  renderMoveBar();
}

// ------------------------------------------------------------- Move here
//
// One click puts a conversation in one place (2026-11-07: "So the user
// needs to understand all this by himself?"). Move here: the hub ends the
// assistant's other processes on that session (in the other terminal, and
// a stale copy in Ravenry), then resumes it in a Ravenry pane, the same one
// when its shell is still there. Keep it in <terminal>: the Ravenry copy
// ends. Mid-turn, the hub waits for the turn to end and does it then; the
// button says so meanwhile. Every move is a line in app.log, with each
// process ended and how.
const moveBusy = new Set<string>();
const moveAsked = new Map<string, { at: number; keep: 'ravenry' | 'outside' }>(); // waiting moves, by session id
let moveFollow: string | null = null; // a Keep it in <terminal>: the middle follows that session's row

function frontSid(): string | null {
  const k = frontKey();
  const f = k && !k.startsWith('tab:') ? findSession(S.hub, k) : null;
  return f ? f.session.sessionId || null : null;
}

type MoveResult = { ok?: boolean; error?: string; waiting?: boolean; name?: string; keep?: 'ravenry' | 'outside'; ended?: NonNullable<HubSession['moved']>['ended']; surfaceId?: string | null; pane?: { id?: string }; projectId?: string; replaced?: string[] };
// The old panes a move replaced: the hub closes them a moment after, and
// their going is not news (no toast, no tab left behind).
const replacedPanes = new Set<string>();

// A move resumed the session in a new pane: it takes the old pane's place,
// in the tab that showed it (a shell tab becomes the session's tab at the
// same position; a pinned session tab follows by its session id).
function swapMoved(b: MoveResult, projectId: string, sid: string): string | null {
  for (const old of b.replaced || []) replacedPanes.add(old);
  if (!b.surfaceId) return null;
  const key = `${b.projectId || projectId}/${b.surfaceId}`;
  let tabId: string | null = null;
  // Its tab from before (in cmux, or an old pane) is its tab still.
  for (const t of S.tabs) if (t.kind === 'session') { const f = findSession(S.hub, t.key); if (f && f.session.sessionId === sid) { t.key = key; tabId = t.id; } }
  for (const old of b.replaced || []) {
    const i = S.tabs.findIndex((t) => t.kind === 'shell' && t.pane === old);
    if (i >= 0) {
      const was = S.tabs[i];
      const nt: SessionTab = { id: pinId(key), kind: 'session', key };
      S.tabs.splice(i, 1, nt);
      if (S.view.kind === 'tab' && S.view.id === was.id) S.view = { kind: 'tab', id: nt.id };
      tabId = nt.id;
    }
    for (const t of S.tabs) if (t.kind === 'session' && t.key.endsWith(`/ravenry:${old}`)) { t.key = key; tabId = t.id; }
  }
  save();
  return tabId;
}
function movedLine(sid: string, b: MoveResult, after = ''): string {
  const ended = (b.ended || []).map((e) => `${e.pid} in ${e.where} (${e.skipped ? 'left alone: no longer on this session' : `${e.signal}${e.ms != null ? `, ${e.ms} ms` : ''}`})`).join(', ') || 'none';
  const old = (b.replaced || []).length ? ` (its old pane ${(b.replaced || []).join(', ')} closes)` : '';
  return `window: move ${sid}${after}: ended ${ended}; ${b.keep === 'outside' ? 'kept in the other terminal' : b.surfaceId ? `resumed in a new pane, ${b.surfaceId}` : 'not resumed'}${old}`;
}
function followMove(sid: string, projectId: string, b: MoveResult): void {
  for (const old of b.replaced || []) replacedPanes.add(old);
  if (b.keep === 'outside') { moveFollow = sid; return; }
  if (!b.surfaceId) return;
  const pane = b.pane && typeof b.pane.id === 'string' ? b.pane.id : null;
  const tabId = swapMoved(b, projectId, sid);
  elseLast = null;
  liveStop();
  setView(tabId ? { kind: 'tab', id: tabId } : { kind: 'session', key: `${b.projectId || projectId}/${b.surfaceId}`, ...(pane ? { pane } : {}) });
}

async function moveTo(p: HubProject, s: HubSession, keep: 'ravenry' | 'outside', why: string): Promise<void> {
  const sid = s.sessionId;
  if (!sid || moveBusy.has(sid)) return;
  moveBusy.add(sid);
  api().log(`window: move ${sid} (${why}): ${keep === 'ravenry' ? 'Move here' : `Keep it in ${s.alsoOpen?.name || 'the other terminal'}`}`);
  render();
  try {
    const { cols, rows } = term.term;
    const r = await api().hubCall('POST', '/api/sessions/move', { projectId: p.id, sessionId: sid, keep, cols, rows });
    const b = (r.body || {}) as MoveResult;
    if (r.status !== 200 || !b.ok) {
      api().log(`window: move ${sid}: not done: ${b.error || r.status}`);
      toast(`Could not move it: ${b.error || `the board answered ${r.status}`}`);
      return;
    }
    if (b.waiting) {
      moveAsked.set(sid, { at: Date.now(), keep });
      api().log(`window: move ${sid}: waiting for ${assistantName(s.assistant) || 'the assistant'} to finish in ${b.name}`);
      return;
    }
    api().log(movedLine(sid, b));
    followMove(sid, p.id, b);
  } catch (e) {
    api().log(`window: move ${sid}: failed: ${(e as Error).message}`);
    toast(`Could not move it: ${(e as Error).message}`);
  } finally {
    moveBusy.delete(sid);
    render();
  }
}

// At each state from the hub: a waiting move it has done since (logged, and
// the middle follows it when that session is in front), and a Keep it in
// <terminal> whose row is back.
function moveStates(): void {
  for (const pr of S.hub?.projects || []) for (const s of pr.sessions) {
    const sid = s.sessionId;
    if (!sid) continue;
    const w = moveAsked.get(sid);
    if (w && s.moved && s.moved.at >= w.at && !s.moving) {
      moveAsked.delete(sid);
      const b: MoveResult = { keep: s.moved.keep, ended: s.moved.ended, surfaceId: s.moved.surfaceId, replaced: s.moved.replaced || [] };
      api().log(movedLine(sid, b, ' after its turn'));
      if (frontSid() === sid || S.view.kind === 'session' && elseLast?.session.sessionId === sid) followMove(sid, pr.id, b);
    }
    if (moveFollow === sid && term_kindOf(s.surfaceId) !== 'ravenry') { moveFollow = null; pickSession(sessionKey(pr.id, s), 'move'); }
  }
}
const term_kindOf = (surfaceId: string): string => (surfaceId.startsWith('ravenry:') ? 'ravenry' : 'other');

/** The words and buttons of a move for one session (bar, card, view). */
function moveActs(p: HubProject, s: HubSession, other: string, why: string, withKeep: boolean): HTMLElement[] {
  const sid = s.sessionId || '';
  const waiting = !!s.moving?.waiting || moveAsked.has(sid);
  const busy = moveBusy.has(sid);
  const who = assistantName(s.assistant) || 'the assistant';
  if (waiting) return [h('button.btn.sm', { disabled: true }, `Waiting for ${who} to finish in ${s.moving?.name || other}`)];
  return [
    h('button.btn.sm.pri', { disabled: busy, title: `End it in ${other} and continue it here`, on: { click: () => void moveTo(p, s, 'ravenry', why) } }, busy ? 'Moving...' : 'Move here'),
    withKeep ? h('button.btn.sm', { disabled: busy, title: `End the copy in Ravenry; it goes on in ${other}`, on: { click: () => void moveTo(p, s, 'outside', why) } }, `Keep it in ${other}`) : null,
  ].filter(Boolean) as HTMLElement[];
}

/** One line across the top of a session's tab, when its conversation is also, or went on, elsewhere. */
function renderMoveBar(): void {
  const el = $('movebar');
  const k = frontKey();
  const f = k && !k.startsWith('tab:') && !$('term').hidden ? findSession(S.hub, k) : null;
  const s = f ? f.session : null;
  let line: string | null = null;
  let other = '';
  if (s && s.surfaceId.startsWith('ravenry:') && s.sessionId) {
    if (s.alsoOpen) { other = s.alsoOpen.name; line = `Also open in ${other}.`; }
    else if (s.movedOn) { other = s.movedOn.name; line = `This conversation went on in ${other}.`; }
    else if (s.moving?.waiting) { other = s.moving.name; line = `Moving it here from ${other}.`; }
  }
  el.hidden = !line;
  if (!line || !f || !s) { replace(el); return; }
  replace(el, h('span.mvt', line), ...moveActs(f.project, s, other, s.alsoOpen ? 'double open, tab' : 'went on elsewhere, tab', !!s.alsoOpen));
}

function tabOfView(): Tab | null {
  const v = S.view;
  return v.kind === 'tab' ? S.tabs.find((t) => t.id === v.id) || null : null;
}

/** The session the middle shows: a pinned session's tab, a session picked in the sidebar, or the one a shell runs. */
function viewSessionKey(): string | null {
  const v = S.view;
  if (v.kind === 'review') return v.key;
  if (v.kind === 'session') return v.key || (v.pane ? sessionOfPane(S.hub, v.pane)?.key || null : null);
  const t = tabOfView();
  if (t && t.kind === 'shell') return sessionOfPane(S.hub, t.pane)?.key || null;
  return t && t.kind === 'session' ? t.key : null;
}

/** The views that take the middle and right columns. */
const WIDE_VIEWS = new Set(['page', 'machines', 'decisions', 'picker', 'grid']);

// While the person keeps the npm board (npmswitch.ts npmChosen), the app runs
// no hub of its own: each view that needs one says so and points at the npm
// board instead (the first-launch place), and so do the controls that open
// one. What was asked for, by view; npmAsked names a control's.
const NEEDS_HUB: Record<string, string> = {
  start: 'Starting a session', page: 'That page', machines: 'Machines', decisions: 'Decisions',
  picker: 'Picking between variants', grid: 'That view', review: 'Reviewing a worktree',
};
let npmAsked: string | null = null;
function npmNeed(): string | null {
  if (!npmChosen()) return null;
  if (npmAsked) return npmAsked;
  if (NEEDS_HUB[S.view.kind]) return NEEDS_HUB[S.view.kind];
  return firstRun() ? NEEDS_HUB.start : null;
}
/** A control that needs the app's hub, while the npm board keeps the data: points there instead. */
function npmPoint(what: string): boolean {
  if (!npmChosen()) return false;
  npmAsked = what;
  setView({ kind: 'start' });
  return true;
}

function firstRun(): boolean {
  if (S.tabs.length) return false;
  if (S.view.kind === 'session' || S.view.kind === 'pane' || S.view.kind === 'review' || WIDE_VIEWS.has(S.view.kind)) return false;
  if (!S.hubStatus) return false; // not known yet
  return !S.hubStatus.reachable || isEmpty(S.hub);
}

const shellId = (pane: string) => `s:${pane}`;
const pinId = (key: string) => `k:${key}`;

function save(): void {
  const t = tabOfView();
  const v = S.view;
  // The session in front with no tab of its own (picked in the sidebar):
  // in front again at the next launch, when its pane is still there.
  const selKey = v.kind === 'session' ? viewSessionKey() : null;
  const selF = selKey ? findSession(S.hub, selKey) : null;
  const selPane = selF ? paneOf(selF.session) : v.kind === 'session' ? v.pane || null : null;
  api().storeSet({
    selected: selKey && selPane ? { key: selKey, pane: selPane } : null,
    // The folder a shell opens in at the next launch when none comes back.
    ...(t && t.kind === 'shell' && t.cwd ? { lastCwd: t.cwd } : {}),
    pinned: S.tabs.filter((x): x is SessionTab => x.kind === 'session').map((x) => x.key),
    order: S.tabs.map((x) => x.id),
    active: t ? t.id : null,
    panelPref: S.panelPref,
    shellsLabelled: true,
    tabs: undefined,
  });
}

// Toasts. A toast with an action (Show, Undo, Update it) stays until it is
// used or dismissed (its x), and at least 12 s; the pointer over it pauses
// its time (2026-11-07, "Didnt have time to click it"). A newer one for
// the same thing (a session's key, a decision's id) replaces the older
// rather than stacking beside it. A plain toast keeps its 5 s, and a newer
// plain one replaces it. A plain toast belongs to the view it was said on:
// moving to another page, tab or session takes it away (renderCentre), so
// it never follows the person; one that explains a move is said after the
// move. A toast said when an action ends carries `at`, the view the action
// started on (here()): if the person has moved on since, news is dropped
// and an error is kept for that view. It shows when they come back, with
// OK, and stays until they press it, so a failed write is never lost.
interface ToastAt { at: string; error: boolean }
interface ToastAction { label: string; run: () => void }
interface ToastItem { key: string; el: HTMLElement; ms: number; left: number; since: number; timer?: number; plain: boolean }
const viewKey = (v: View): string => (v.kind === 'page' ? `page|${v.key}` : JSON.stringify(v));
const here = (): string => viewKey(S.view);
const kept = new Map<string, string[]>();
const toasts: ToastItem[] = [];
const ACTION_MS = 12000;
const PLAIN_MS = 5000;
let toastHover = false;

function toastBox(): HTMLElement {
  const el = $('toast');
  if (!el.dataset.wired) {
    el.dataset.wired = '1';
    el.addEventListener('mouseenter', () => { toastHover = true; for (const t of toasts) pauseToast(t); });
    el.addEventListener('mouseleave', () => { toastHover = false; for (const t of toasts) runToast(t); });
  }
  return el;
}
function pauseToast(t: ToastItem): void {
  if (t.timer === undefined) return;
  clearTimeout(t.timer);
  t.timer = undefined;
  t.left = Math.max(0, t.left - (Date.now() - t.since));
}
function runToast(t: ToastItem): void {
  if (!Number.isFinite(t.ms) || toastHover || t.timer !== undefined) return;
  t.since = Date.now();
  // Back from under the pointer: a moment more to read it.
  t.timer = window.setTimeout(() => dropToast(t), Math.max(t.left, 2000));
}
function dropToast(t: ToastItem): void {
  clearTimeout(t.timer);
  const i = toasts.indexOf(t);
  if (i >= 0) toasts.splice(i, 1);
  t.el.remove();
  $('toast').hidden = toasts.length === 0;
}

/**
 * One toast. `actions` makes it stay until used or dismissed, at least
 * `ms` (12 s at least; Infinity: until pressed). `key` names what it is
 * about: a newer toast with the same key replaces it.
 */
function showToast(text: string, actions: ToastAction[] = [], opts: { key?: string; ms?: number } = {}): void {
  const el = toastBox();
  const plain = actions.length === 0;
  const key = opts.key || (plain ? 'plain' : `say:${text}`);
  for (const t of toasts.filter((x) => x.key === key)) dropToast(t);
  const ms = plain ? opts.ms ?? PLAIN_MS : Math.max(opts.ms ?? ACTION_MS, ACTION_MS);
  const item: ToastItem = { key, el: h('div.ti'), ms, left: ms, since: Date.now(), plain };
  replace(item.el, h('span.tt', text),
    ...actions.map((a) => h('button.lk', { on: { click: () => { dropToast(item); a.run(); } } }, a.label)),
    plain ? null : h('button.tx', { title: 'Dismiss', 'aria-label': 'Dismiss', on: { click: () => dropToast(item) } }, svg(I.CLOSE)));
  toasts.push(item);
  // At most three at once: the oldest goes.
  while (toasts.length > 3) dropToast(toasts[0]);
  el.append(item.el);
  el.hidden = false;
  runToast(item);
}

function toast(text: string, undo?: ToastAction, at?: ToastAt): void {
  if (at && at.at !== here()) {
    if (at.error) { const l = kept.get(at.at) || []; if (!l.includes(text)) l.push(text); kept.set(at.at, l); }
    return;
  }
  showToast(text, undo ? [undo] : []);
}

/** A toast with links (the decision ledger's Undo and Show; a session that needs you). */
function toastLinks(text: string, links: ToastAction[], key?: string): void {
  showToast(text, links, { key, ms: links.some((l) => l.label === 'Undo') ? 60000 : ACTION_MS });
}

function showKept(where: string): void {
  const l = kept.get(where);
  if (!l || !l.length) return;
  showToast(l.join(' '), [{ label: 'OK', run: () => { kept.delete(where); } }], { key: `kept:${where}`, ms: Infinity });
}

let toastWhere = '';
function toastFollows(where: string): void {
  if (where === toastWhere) return;
  const first = !toastWhere;
  toastWhere = where;
  // Plain news and another view's kept errors go; a toast with an action
  // stays until it is used or dismissed.
  if (!first) for (const t of toasts.filter((x) => x.plain || x.key.startsWith('kept:'))) dropToast(t);
  showKept(where);
}

function shellLabel(t: ShellTab): { name: string; sub: string | null } {
  // The pane's title when its program set one, else the program's name;
  // then the folder it is in (~ for home).
  const agent = t.agent ? assistantName(t.agent) : null;
  const title = (t.title || '').trim();
  const prog = base((t.command || [])[0] || '') || 'Shell';
  const home = S.config?.home;
  const folder = t.cwd && home && t.cwd === home ? '~' : base(t.cwd);
  const own = t.name && t.name !== 'Shell' ? t.name : '';
  const name = agent || own || title || prog;
  // A pane an agent opened says whose it is ("Claude's"), as its folder would.
  const c = store.get(t.pane)?.pane.creator;
  if (c && c.kind === 'agent') return { name, sub: `${sourceOf(c).who}'s` };
  return { name, sub: secondLine(name, folder) };
}

function tabLabel(t: Tab): { name: string; sub: string | null; group: Group | null; machine: string | null } {
  if (t.kind === 'shell') {
    // A shell the board follows as a session (an assistant runs in it) reads as that session.
    const f = sessionOfPane(S.hub, t.pane);
    if (f) { const name = f.session.topic || f.project.name; return { name, sub: secondLine(name, f.project.name), group: openCpOn(t.pane) ? 'you' : sessionGroup(f.session), machine: null }; }
    const l = shellLabel(t);
    const st = t.status?.state;
    const group: Group | null = openCpOn(t.pane) || st === 'needs_you' ? 'you' : st === 'working' ? 'work' : null;
    return { ...l, group, machine: null };
  }
  const f = findSession(S.hub, t.key);
  // Off the board for now (it ended, or between two states): the name it had.
  if (!f) return { name: t.name || 'Session', sub: null, group: 'idle', machine: null };
  const name = f.session.topic || f.project.name;
  t.name = name;
  return { name, sub: secondLine(name, f.project.name), group: hasOpenCp(f.project, f.session) ? 'you' : sessionGroup(f.session), machine: machineOf(f.project, f.session) };
}

const GROUP_VAR: Record<Group, string> = { you: 'var(--you)', work: 'var(--work)', wait: 'var(--wait)', idle: 'var(--idle)' };
const RING: Record<Group, string> = { you: I.RING_YOU, work: I.RING_WORK, wait: I.RING_WAIT, idle: I.RING_IDLE };
const MARK_ICON: Record<string, string> = { ask: I.ASK, approve: I.RUN, secret: I.KEY, drive: I.KEYBOARD, pick: I.PICK, review: I.REVIEW, other: I.ASK };

function machineTag(name: string | null): HTMLElement | null {
  return name ? h('span.mt', { title: `Runs on ${name}` }, svg(I.MACHINE), name) : null;
}

/** Replaces a node's children, leaving in place the ones it keeps, so a kept card never loses its focus. */
function patch(parent: Element, nodes: (Node | null | undefined | false)[]): void {
  const want = nodes.filter((n): n is Node => !!n);
  const keep = new Set(want);
  for (const c of [...parent.childNodes]) if (!keep.has(c)) parent.removeChild(c);
  want.forEach((n, i) => { if (parent.childNodes[i] !== n) parent.insertBefore(n, parent.childNodes[i] || null); });
}

// ---------------------------------------------------------------- checkpoints

/** The open checkpoint of a pane, if any (local panes: no machine). */
function openCpOn(pane: string, machine: string | null = null): Known | null {
  const k = S.cps.forPane(pane, machine, now());
  return k && isOpen(k.cp) ? k : null;
}

function sessionPane(p: HubProject, s: HubSession): { pane: string | null; machine: string | null } {
  return { pane: paneOf(s), machine: s.machine || p.machine || null };
}

/** The checkpoint a session's card shows: open, or the one that just closed. */
function cpOfSession(p: HubProject, s: HubSession): Known | null {
  for (const k of S.cps.items.values()) if (k.cp.projectId === p.id && k.cp.surfaceId === s.surfaceId && isOpen(k.cp)) return k;
  const { pane, machine } = sessionPane(p, s);
  return pane ? S.cps.forPane(pane, machine, now()) : null;
}

function hasOpenCp(p: HubProject, s: HubSession): boolean {
  const k = cpOfSession(p, s);
  return !!k && isOpen(k.cp);
}

/** Where a checkpoint shows: its session, the shell tab it runs in, or on its own. */
function targetOf(k: Known): string {
  const cp = k.cp;
  if (cp.projectId && cp.surfaceId) {
    const key = `${cp.projectId}/${cp.surfaceId}`;
    if (findSession(S.hub, key)) return key;
  }
  if (cp.pane) {
    if (!cp.machine) {
      const t = S.tabs.find((x): x is ShellTab => x.kind === 'shell' && x.pane === cp.pane && (!k.socket || x.socket === k.socket));
      if (t) return `tab:${t.id}`;
    }
    for (const p of S.hub?.projects || []) for (const s of p.sessions) {
      const sp = sessionPane(p, s);
      if (sp.pane === cp.pane && (sp.machine || null) === (cp.machine || null)) return sessionKey(p.id, s);
    }
  }
  return `cp:${cp.id}`;
}

/** The marks on the sidebar's rows, by session key. */
function rowMarks(): Map<string, RowMark> {
  const out = new Map<string, RowMark>();
  // 33: a worktree session done and with work to review needs you.
  for (const p of S.hub?.projects || []) for (const s of p.sessions) {
    const n = review ? review.readyFiles(s) : null;
    if (n) out.set(sessionKey(p.id, s), { kind: 'review', text: `Done. ${n} file${n === 1 ? '' : 's'} to review`, code: false, since: s.since || new Date(now()).toISOString() });
  }
  for (const k of S.cps.open()) {
    const t = targetOf(k);
    if (t.startsWith('tab:') || t.startsWith('cp:') || (out.has(t) && out.get(t)!.kind !== 'review')) continue;
    const m = markOf(k.cp);
    if (k.cp.kind === 'drive' && k.cp.drive) m.text = `${driveVerb(k.cp).row} ${paneNameOf(k.cp.drive.pane)}`;
    out.set(t, { ...m, since: k.cp.created_at });
  }
  return out;
}

/** The pane a checkpoint's agent runs in, as people know it. */
function paneName(pane: string | undefined, machine: string | null | undefined): string {
  if (!pane) return 'its session';
  if (!machine) {
    const t = S.tabs.find((x): x is ShellTab => x.kind === 'shell' && x.pane === pane);
    if (t) return tabLabel(t).name;
  }
  for (const p of S.hub?.projects || []) for (const s of p.sessions) if (paneOf(s) === pane) return s.topic || p.name;
  return 'its session';
}

/** Whether this window may answer a checkpoint: the daemon that holds it, or else the hub, takes it as the person. */
function canAnswer(k: Known): boolean {
  if (k.socket && !S.notPerson.has(k.socket)) return true;
  if (k.socket && S.notPerson.has(k.socket)) return false;
  return !S.hubRefused;
}

/**
 * Answers a checkpoint: through the daemon that holds it when this window
 * holds it, else through the hub. An edited command and a reason go with
 * the answer both ways; a daemon too old for them refuses the answer
 * (bad_request), and then nothing ran.
 */
async function answerCp(k: Known, reply: Reply): Promise<void> {
  if (k.socket) {
    const c = await daemons.get(k.socket).catch(() => null);
    if (c && !c.closed) {
      try {
        const { checkpoint } = await c.request('checkpoint.answer', daemonAnswer(k.cp.id, reply));
        S.cps.update(checkpoint);
        render();
        return;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'forbidden') { S.notPerson.add(k.socket); render(); throw new NotPerson(); }
        if (code === 'not_found') throw new Error('It closed already: answered somewhere else, withdrawn, or out of time.');
        if (code === 'bad_request' && ('command' in reply || 'reason' in reply)) throw new Error(`This ravenryd did not take the answer, so nothing ran: ${(e as Error).message}. An older ravenryd cannot run an edited command or pass a reason on; update it, or answer without them.`);
        if (!k.hub) throw new Error(`ravenryd did not take the answer: ${(e as Error).message}`);
      }
    }
  }
  if (!k.hub) throw new Error('The daemon that asked is not reachable any more.');
  const r = await api().hubAnswer(hubAnswer(k.cp.id, reply));
  if (r.status === 403) { S.hubRefused = true; render(); throw new NotPerson(); }
  if (!r.ok) throw new Error(r.error || 'The board did not take the answer.');
  if (r.checkpoint) S.cps.update(r.checkpoint as HubCheckpoint);
  render();
}

const cardCtx: CardCtx = {
  now,
  get platform() { return S.config?.platform || 'darwin'; },
  tilde,
  phoneToo: (k) => k.hub && !!S.hubStatus?.reachable && !!S.hub?.alerts?.enabled && !!S.hub?.alerts?.configured,
  paneName: (k) => paneName(k.cp.pane, k.cp.machine),
  canAnswer,
  answer: answerCp,
  showRun: (k) => (k.socket && k.cp.run?.pane ? () => setView({ kind: 'pane', socket: k.socket!, pane: k.cp.run!.pane, name: 'Command' }) : null),
  drive: (k) => {
    const d = k.cp.drive;
    const asker = d ? sourceOf(d.agent) : { who: assistantName(k.cp.assistant) || 'The agent', where: null, cls: 'other' };
    const pane = d ? d.pane : '';
    const kn = pane ? store.get(pane) : null;
    const c = kn?.pane.creator;
    const shellish = /(^|\/)(zsh|bash|sh|fish|login)$/.test((kn?.pane.command || [])[0] || '') || kn?.pane.labels?.['ravenry.kind'] === 'shell';
    return {
      who: assistantName(k.cp.assistant) || asker.who,
      session: asker.where,
      pane: pane ? paneNameOf(pane) : 'a pane',
      // Another agent's session is said as one, so its card reads as asking to type to that agent.
      what: pane && sessionOfPane(S.hub, pane) ? `${assistantName(sessionOfPane(S.hub, pane)!.session.assistant) || 'an agent'}'s session` : !c || c.kind === 'person' ? (shellish ? 'a shell' : 'a pane you opened') : `${sourceOf(c).who}'s pane`,
      opened: kn ? `By ${!c || c.kind === 'person' ? 'you' : sourceOf(c).who}, at ${timeOf(kn.pane.created_at, now())}` : null,
      folder: kn?.pane.cwd ? tilde(kn.pane.cwd) : null,
    };
  },
  variantSrc: (k, n) => variantSrc(k, n),
  openPicker: (k) => openPicker(k),
  checked: (k) => checkedFor(k),
  answered: () => {
    // Answered: a narrow window goes back to the terminal, and the keyboard
    // goes back to the terminal unless it is somewhere else on purpose.
    if (S.overlay) { S.overlay = false; S.panelKey = null; render(); term.focus(); return; }
    const a = document.activeElement;
    if (!a || a === document.body || a.closest('#panel')) term.focus();
  },
};

/** A checkpoint opened: the panel opens on it, over the terminal on a narrow window. */
// Something needs the person (a checkpoint opened, a session moved into
// Needs you). The selection is what is in front and nothing else (on
// 2026-11-07 the panel showed a session while the launch shell was in
// front: "why I need to click it again to select?"), so an arrival never
// moves the panel off it:
// in front already, the panel shows it; else a toast says so, with Show,
// which selects it. Only a checkpoint no session or tab holds opens over.
function arrive(k: Known): void {
  if (firstRun()) return;
  const t = targetOf(k);
  if (t.startsWith('cp:')) { S.panelKey = t; if (!panelVisible()) S.overlay = true; return; }
  arrivedAt(t);
}
// Never about the session in front (its tab already shows it). Named as its
// sidebar row names it (its title, and its project when that differs),
// with what it asks, so two sessions of one project are told apart. One
// toast per session, by its session id: a newer one replaces it, and it
// goes when that session comes to the front (dropFrontToast).
function arrivedAt(t: string): void {
  if (frontKey() === t) { if (!panelVisible()) S.overlay = true; return; }
  const f = t.startsWith('tab:') ? null : findSession(S.hub, t);
  if (f && f.session.sessionId && frontSid() === f.session.sessionId) return;
  const tab = t.startsWith('tab:') ? S.tabs.find((x) => x.id === t.slice(4)) : null;
  const title = f ? f.session.topic || f.project.name : tab ? tabLabel(tab).name : 'A session';
  const proj = f ? secondLine(title, f.project.name) : null;
  const w = f ? f.session.words || {} : {};
  const what = String(w.question || w.headline || w.line || '').replace(/\s+/g, ' ').trim();
  const said = what ? `: ${what.length > 70 ? what.slice(0, 69).replace(/\s+\S*$/, '') + '...' : what}` : '.';
  toastLinks(`${title}${proj ? ` in ${proj}` : ''} needs you${said}`, [{ label: 'Show', run: () => { if (tab) setView({ kind: 'tab', id: tab.id }); else pickSession(t, 'notification'); } }], toastKeyOf(t));
}
function toastKeyOf(t: string): string {
  const f = t.startsWith('tab:') ? null : findSession(S.hub, t);
  return `needs:${f && f.session.sessionId ? f.session.sessionId : t}`;
}
/** The toast about whatever is in front goes: the person is looking at it. */
function dropFrontToast(): void {
  const k = frontKey();
  if (!k) return;
  const sid = frontSid();
  for (const t of toasts.filter((x) => x.key === `needs:${k}` || (sid && x.key === `needs:${sid}`))) dropToast(t);
}

/**
 * What is in front, as one key: a session's ("<project>/<surface>"), also
 * when it runs in a shell tab or a pinned tab, else a plain shell tab's
 * ("tab:<id>"), else null. The sidebar's highlight and the panel follow it,
 * and nothing else (one place: frontKey, panelTargetKey, the rows' sel).
 */
let rowPressedAt = 0; // a sidebar row's last press (its click then does nothing more)

function frontKey(): string | null {
  const key = viewSessionKey();
  if (key) return key;
  const t = tabOfView();
  return t ? `tab:${t.id}` : null;
}

async function closedOnHub(ids: string[]): Promise<void> {
  // The hub stopped listing them (answered on the phone, cancelled, expired):
  // its recent closed ones say how.
  try {
    const r = await api().hubGet('/api/checkpoints?all') as { checkpoints?: HubCheckpoint[] };
    for (const cp of r.checkpoints || []) if (ids.includes(cp.id)) S.cps.update(cp);
    render();
  } catch { /* the hub went away */ }
}

// ---------------------------------------------------------------- sidebar

function renderSidebar(): void {
  const empty = firstRun();
  const groups = board(S.hub, now(), rowMarks());
  const counts: Record<Group, number> = { you: 0, work: 0, wait: 0, idle: 0 };
  for (const g of groups) counts[g.group] = g.count;
  const total = counts.you + counts.work + counts.wait + counts.idle;

  const brand = h('div.brand', svg(I.LOGO), 'Ravenry', h('span.sp'),
    h('button.icon-btn.sm', { title: `New session (${shortcut('N')})`, 'aria-label': 'New session', on: { click: () => openStart() } }, svg(I.PLUS())));

  let list: HTMLElement;
  if (empty || !groups.length) {
    list = h('div.sl', h('div.empty-side', S.hubStatus?.starting?.waitingFor
      ? `Your sessions show up here once macOS lets Ravenry read ${S.hubStatus.starting.waitingFor}.`
      : S.hubStatus && !S.hubStatus.reachable
        ? 'Your sessions show up here, the ones that need you on top, once the board is running.'
        : 'Your sessions show up here, the ones that need you on top.'));
  } else {
    list = h('div.sl', groups.map((g) => h(`section.grp.g-${g.group}`,
      h('div.grp-h', svg(RING[g.group]), h('span.t', g.title), h(`span.cnt.c-${g.group}`, String(g.count))),
      g.projects.map((pr) => {
        if (g.group === 'idle') {
          return h('button.idl', { on: { pointerdown: (e: Event) => { if ((e as PointerEvent).button === 0) { rowPressedAt = Date.now(); pickProject(pr.project); } }, click: () => { if (Date.now() - rowPressedAt > 1500) pickProject(pr.project); } } },
            h('span.n', pr.project.name), machineTag(pr.machine), h('span.t3.num.when', pr.time));
        }
        return [
          h('div.pj', h('span.n', pr.project.name), machineTag(pr.machine), h('span.t3.num.when', pr.time)),
          pr.rows.map((r) => {
            const sel = frontKey() === r.key;
            const pinned = S.tabs.some((t) => t.kind === 'session' && t.key === r.key);
            const second = r.mark
              ? h('div.ss-q.k', h('span.kd', svg(MARK_ICON[r.mark.kind])), h(`span.qt${r.mark.code ? '.code' : ''}`, r.mark.text))
              : r.line ? h('div.ss-q', r.line) : useLine(r.session);
            // On pointerdown, not click: the sidebar is drawn again at each
            // state from the hub (about once a second), and a click whose
            // press and release land on two drawings never fires.
            // (A click with no press before it, as from assistive tools, still selects.)
            return h(`div.ss${sel ? '.sel' : ''}`, { role: 'button', tabindex: '0', 'data-key': r.key, on: { pointerdown: (e: Event) => { if ((e as PointerEvent).button === 0 && !(e.target as HTMLElement).closest('button.pin')) { rowPressedAt = Date.now(); pickSession(r.key); } }, click: (e: Event) => { if (Date.now() - rowPressedAt > 1500 && !(e.target as HTMLElement).closest('button.pin')) pickSession(r.key); }, keydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') pickSession(r.key); } } },
              h('div.ss-r',
                h('span.sd', { style: { background: GROUP_VAR[r.group] } }),
                h('span.n', r.name),
                r.assistant ? h('span.as-tag', r.assistant) : null,
                r.pct !== null ? h(`span.pc.num${r.pctWarn ? '.warn' : ''}`, `${r.pct}%`) : h('span.pc'),
                h(`button.pin${pinned ? '.on' : ''}`, { title: pinned ? 'Unpin from the tabs' : 'Pin to the tabs', 'aria-label': pinned ? 'Unpin' : 'Pin', on: { click: (e: Event) => { e.stopPropagation(); togglePin(r.key); } } }, svg(I.PIN))),
              second);
          }),
        ];
      }))));
  }

  // The pages, from their files (pages.ts): the shipped ones, then the ones
  // you or an agent added, then a project's own.
  const rowsNav = pages.nav(S.view.kind === 'page' ? S.view.key : null, (key) => openPage(key));
  const decRow = h(`button.vrow${S.view.kind === 'decisions' ? '.sel' : ''}`, { 'data-page': 'decisions', title: 'Decisions', on: { click: () => { if (npmPoint('Decisions')) return; S.overlay = false; S.panelKey = null; setView({ kind: 'decisions' }); } } },
    svg(I.BOOK), h('span.vl', 'Decisions'), decisions.active.length ? h('span.c.num', decisions.list.some((d) => d.undo_until && Date.parse(d.undo_until) > now()) ? h('i.ndot') : null, String(decisions.active.length)) : null);
  const gapAt = rowsNav.findIndex((e) => e.classList.contains('gap'));
  rowsNav.splice(gapAt < 0 ? rowsNav.length : gapAt, 0, decRow);
  const nav = h(`nav.nav${empty ? '.dim' : ''}`, rowsNav);

  const mem = memoryLine(S.hub);
  const foot = h('div.foot',
    h('button.icon-btn', { title: 'Settings', 'aria-label': 'Settings', on: { click: () => openBoard('') } }, svg(I.SETTINGS)),
    empty ? null : h(`button.icon-btn${phoneCard.open ? '.on' : ''}`, { title: 'Open on your phone', 'aria-label': 'Open on your phone', 'aria-haspopup': 'dialog', on: { click: (e: Event) => { if (npmPoint('Pairing a phone')) return; phoneCard.toggle(e.currentTarget as HTMLElement); } } }, svg(I.PHONE)),
    empty ? null : h(`button.icon-btn${counts.you ? '.alert' : ''}`, { title: 'Alerts', 'aria-label': 'Alerts', on: { click: () => openBoard('') } }, svg(I.BELL)),
    h(`button.icon-btn.m-foot${S.view.kind === 'machines' ? '.on' : ''}`, { title: machinesView && machinesView.attention() ? 'Machines: one needs you' : 'Machines', 'aria-label': 'Machines', on: { click: () => { if (!npmPoint('Machines')) setView({ kind: 'machines' }); } } }, svg(MACHINES_ICON), machinesView && machinesView.attention() ? h('i.bdot') : null),
    h('span.sp'),
    mem && !empty ? h('span.mem.num', `Claude ${mem}`) : null);

  const mix = !empty && total ? h('div.mix', (['you', 'work', 'wait', 'idle'] as Group[]).filter((g) => counts[g]).map((g) => h('span', { style: { flex: String(counts[g]), background: GROUP_VAR[g] } }))) : null;

  // A folder macOS did not let the board read: its projects show without
  // their files, and one line says where to turn it on.
  const denied = S.hub?.access?.denied || [];
  const asking = S.hubStatus?.starting?.waitingFor ? S.hubStatus.starting : null;
  const deniedNote = asking
    ? h('div.access-note', h('b', `macOS is asking whether Ravenry may read ${asking.waitingFor}. Click Allow in the dialog.`), ' ', `Closed it? System Settings > Privacy & Security > Files & Folders > Ravenry, turn on ${asking.folder || asking.waitingFor}.`, h('button.lk.ac-open', { on: { click: () => api().openExternal(PRIVACY_PANE) } }, 'Open Files & Folders'))
    : denied.length ? h('div.access-note', `macOS did not let Ravenry read ${denied.map((d) => d.folder).join(', ')}. Turn it on in System Settings > Privacy & Security > Files & Folders.`) : null;
  replace($('side'), h('div.side-top'), brand, mix, deniedNote, list, empty ? h('span.fill') : null, nav, foot);
}

/** 19: "Using dev server" for the session that holds a pane, "Waiting for dev server, Claude has it" for one in line. */
function useLine(s: HubSession): HTMLElement | null {
  const pane = paneOf(s);
  if (!pane) return null;
  const held = store.heldBy(pane)[0];
  if (held) return h('div.ss-q.use.holds', svg(I.HOLDS), h('span.qt', `Using ${paneNameOf(held.pane.id)}`));
  const w = store.waitedBy(pane)[0];
  if (w) return h('div.ss-q.use', svg(I.CLOCK), h('span.qt', `Waiting for ${paneNameOf(w.k.pane.id)}, ${sourceOf(w.holder).who} has it`));
  return null;
}

function openBoard(hash: string): void {
  if (!S.config) return;
  // The npm board's own page, when it answers; else where it is said why.
  if (npmChosen() && !S.hubStatus?.reachable) { npmPoint('Settings and alerts'); return; }
  api().openExternal(S.config.hubUrl + '/' + hash);
}

function openPage(key: string): void {
  if (npmPoint('That page')) return;
  S.overlay = false;
  S.panelKey = null;
  setView({ kind: 'page', key });
}

function pickProject(p: HubProject): void {
  const s = p.sessions.find((x) => x.surfaceId === p.primary) || p.sessions[0];
  if (s) pickSession(`${p.id}/${s.surfaceId}`);
}

// Selecting a session (a click on its row, a notification's Show, a pane
// asked to show) brings it to the front: the tab that shows its pane, else
// its own tab (its pane, or the outside-terminal view). Each one is said in
// app.log with what it did.
function pickSession(key: string, why = 'click'): void {
  // A session that runs in a pane a tab already shows: that tab.
  const f = findSession(S.hub, key);
  const pane = f ? paneOf(f.session) : null;
  const pinned = S.tabs.find((t) => (t.kind === 'session' && t.key === key) || (pane && t.kind === 'shell' && t.pane === pane));
  api().log(`window: session ${why} ${key}: ${!f ? 'not on the board' : pinned ? `its tab ${pinned.id}` : pane ? `its pane ${pane}` : 'its view outside Ravenry'}`);
  S.panelKey = null;
  // A session waiting at a checkpoint: its card gets the keyboard, never the
  // terminal (a pasted secret must not land in the open), and on a narrow
  // window the panel opens over the terminal.
  const k = f ? cpOfSession(f.project, f.session) : null;
  if (k && isOpen(k.cp)) {
    S.focusCp = k.cp.id;
    if (!wide()) S.overlay = true;
  }
  setView(pinned ? { kind: 'tab', id: pinned.id } : { kind: 'session', key });
}

function togglePin(key: string): void {
  const i = S.tabs.findIndex((t) => t.kind === 'session' && t.key === key);
  if (i >= 0) {
    removeTab(S.tabs[i].id);
  } else {
    const t: SessionTab = { id: pinId(key), kind: 'session', key };
    S.tabs.push(t);
    if (S.view.kind === 'session' && viewSessionKey() === key) S.view = { kind: 'tab', id: t.id };
  }
  save();
  render();
}

// ---------------------------------------------------------------- tabs

/** A session's Review tab, beside its session (every session and pane is a tab of the strip: setView). */
function openTab(): HTMLElement | null {
  const v = S.view;
  if (v.kind === 'review') {
    // The session's own tab, beside its Review tab (when it has no tab).
    if (S.tabs.some((t) => (t.kind === 'session' && t.key === v.key) || (t.kind === 'shell' && sessionOfPane(S.hub, t.pane)?.key === v.key))) return null;
    const f = findSession(S.hub, v.key);
    if (!f) return null;
    const name = f.session.topic || f.project.name;
    return h('div.tab', { role: 'tab', 'aria-selected': 'false', title: name, on: { click: () => setView({ kind: 'session', key: v.key }) } },
      h('span.sd', { style: { background: GROUP_VAR[hasOpenCp(f.project, f.session) ? 'you' : sessionGroup(f.session)] } }),
      h('span.n', name), secondLine(name, f.project.name) ? h('span.p', f.project.name) : null);
  }
  return null;
}

function renderTabs(): void {
  const el = $('tabs');
  if (npmTakesCentre() || firstRun() || S.view.kind === 'start' && !S.tabs.length) { el.hidden = true; return; }
  el.hidden = false;
  const active = tabOfView();
  const rk = viewSessionKey();
  const rf = rk ? findSession(S.hub, rk) : null;
  const rv = rf && rf.session.worktree && rf.session.worktree.state === 'open'
    ? h(`div.tab${S.view.kind === 'review' ? '.on' : ''}`, { role: 'tab', 'aria-selected': S.view.kind === 'review' ? 'true' : 'false', title: 'Review its work', on: { click: () => setView({ kind: 'review', key: rk! }) } },
      h('span.ti', svg(I.REVIEW)), h('span.n', 'Review'), h('span.p', rf.session.worktree.branch.replace(/^ravenry\//, '')),
      S.view.kind === 'review' ? h('button.x', { title: 'Close the review', 'aria-label': 'Close', on: { click: (e: Event) => { e.stopPropagation(); setView({ kind: 'session', key: rk! }); } } }, svg(I.CLOSE)) : null)
    : null;
  const sessTab = (t: Tab) => (t.kind === 'session' && t.key === rk) || (t.kind === 'shell' && !!rk && sessionOfPane(S.hub, t.pane)?.key === rk);
  const filmable = !!paneOnScreen() && !$('term').hidden;
  const row = h('div.tabrow', { role: 'presentation' },
    openTab(),
    rv && !S.tabs.some(sessTab) ? rv : null,
    S.tabs.map((t, i) => {
      const l = tabLabel(t);
      const on = active && active.id === t.id;
      if (on && t.kind === 'shell') t.activity = false;
      const tk = t.kind === 'session' ? t.key : sessionOfPane(S.hub, t.pane)?.key || `tab:${t.id}`;
      return h(`div.tab${on ? '.on' : ''}`, { role: 'tab', 'aria-selected': on ? 'true' : 'false', 'data-key': tk, title: i < 9 ? `${l.name} (${isMac() ? '⌘' : 'Alt+'}${i + 1})` : l.name, on: { click: () => setView({ kind: 'tab', id: t.id }), auxclick: (e: Event) => { if ((e as MouseEvent).button === 1) closeTab(t.id); } } },
        t.kind === 'shell' && !l.group ? h('span.ti', svg(I.SHELL)) : h('span.sd', { style: { background: GROUP_VAR[l.group || 'idle'] } }),
        h('span.n', l.name),
        l.sub ? h('span.p', l.sub) : null,
        machineTag(l.machine),
        t.kind === 'shell' ? leaseBadge(t.pane) : null,
        t.kind === 'shell' && t.activity && !on ? h('span.act', { title: 'New output' }) : null,
        h('button.x', { title: t.kind === 'shell' ? `Close (${shortcut('W')})` : 'Close the tab (the session goes on)', 'aria-label': 'Close', on: { click: (e: Event) => { e.stopPropagation(); closeTab(t.id); } } }, svg(I.CLOSE)));
    }).flatMap((tab, i) => (rv && sessTab(S.tabs[i]) ? [tab, rv] : [tab])));
  replace(el,
    row,
    h('button.tab.add', { title: `New shell (${shortcut('T')})`, 'aria-label': 'New shell', on: { click: () => void newShell() } }, svg(I.PLUS(12))),
    h('span.sp'),
    filmable ? h(`button.icon-btn${film.open ? '.on' : ''}`, { title: 'The last 20 seconds of this pane', 'aria-label': 'Filmstrip', on: { click: () => { const pn = paneOnScreen(); if (pn) void film.toggle(pn); } } }, svg(I.FILM)) : null,
    h(`button.icon-btn${panelVisible() ? '.on' : ''}`, { title: panelVisible() ? 'Hide the session panel' : 'Show the session panel', 'aria-label': 'Session panel', on: { click: () => togglePanel() } }, svg(I.PANEL)));
  fitTabs(el);
}

/** 19 A: who holds a lent pane, on its tab. */
function leaseBadge(pane: string): HTMLElement | null {
  const w = leaseWords(pane, paneCtx);
  return w ? h(`span.lbadge.${w.holder.cls}`, { title: `${w.holder.who} has this pane` }, svg(I.HOLDS), w.holder.who) : null;
}

/**
 * When the tabs crowd: the grey second lines go first, then the strip
 * scrolls (to the tab on screen). A tab never shrinks, so a name is never
 * cut short to fit.
 */
function fitTabs(el: HTMLElement): void {
  const row = el.querySelector('.tabrow') as HTMLElement | null;
  if (!row) return;
  el.classList.remove('no-sub');
  if (row.scrollWidth <= row.clientWidth + 1) return;
  el.classList.add('no-sub');
  if (row.scrollWidth <= row.clientWidth + 1) return;
  (row.querySelector('.tab.on') as HTMLElement | null)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

async function newShell(folder?: string | null): Promise<void> {
  const at = here();
  try {
    const { client, socket } = await daemons.forNew();
    const cur = tabOfView();
    const cwd = folder || (cur && cur.kind === 'shell' && cur.cwd ? cur.cwd : undefined);
    const { cols, rows } = term.term;
    const cmd = S.config?.newShell;
    const { pane } = await client.request('pane.new', { cols, rows, name: 'Shell', labels: { ...SHELL_LABEL }, ...(cmd ? { command: cmd } : {}), ...(cwd ? { cwd } : {}) });
    addShellTab(socket, pane, null, true);
  } catch (e) {
    toast(`Could not open a shell: ${(e as Error).message}`, undefined, { at, error: true });
  }
}

function addShellTab(socket: string, pane: Pane, agent: string | null, show: boolean): ShellTab {
  const had = S.tabs.find((x): x is ShellTab => x.kind === 'shell' && x.pane === pane.id);
  if (had) { if (show) setView({ kind: 'tab', id: had.id }); return had; }
  const t: ShellTab = { id: shellId(pane.id), kind: 'shell', socket, pane: pane.id, agent: agent ?? pane.labels?.['ravenry.agent'] ?? null };
  applyPane(t, pane);
  const cur = tabOfView();
  const at = cur ? S.tabs.indexOf(cur) + 1 : S.tabs.length;
  S.tabs.splice(at, 0, t);
  if (show) setView({ kind: 'tab', id: t.id });
  else { save(); render(); }
  return t;
}

/** An agent's own pane: made by an agent in a pane, shown, running. */
function agentPane(p: Pane): boolean {
  return p.creator?.kind === 'agent' && !!p.creator.pane && !p.hidden && p.state === 'running' && p.labels?.['ravenry.kind'] !== 'shell';
}

/** An agent's own pane as a tab, right after its session's tab (and its other panes), else at the end. */
function addAgentPaneTab(socket: string, p: Pane): ShellTab {
  const owner = p.creator!.pane!;
  const t: ShellTab = { id: shellId(p.id), kind: 'shell', socket, pane: p.id, owner };
  applyPane(t, p);
  const ofOwner = (x: Tab) => (x.kind === 'shell' && (x.pane === owner || x.owner === owner))
    || (x.kind === 'session' && (x.pane === owner || x.key.endsWith(`/ravenry:${owner}`) || (() => { const f = findSession(S.hub, x.key); return !!f && paneOf(f.session) === owner; })()));
  let at = -1;
  S.tabs.forEach((x, i) => { if (ofOwner(x)) at = i; });
  S.tabs.splice(at < 0 ? S.tabs.length : at + 1, 0, t);
  return t;
}

function applyPane(t: ShellTab, p: Pane): void {
  t.status = p.agent || null;
  t.title = p.title;
  t.name = p.name;
  t.cwd = p.cwd;
  t.command = p.command;
  t.cols = p.cols;
  t.rows = p.rows;
  t.createdAt = p.created_at;
}

async function closeTab(id: string): Promise<void> {
  const i = S.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const t = S.tabs[i];
  removeTab(id);
  if (t.kind === 'shell') {
    // The daemon ends the pane's whole process tree.
    try { const c = await daemons.get(t.socket); await c.request('pane.close', { pane: t.pane }); } catch { /* already gone */ }
  }
}

function removeTab(id: string): void {
  const i = S.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const t = S.tabs[i];
  S.tabs.splice(i, 1);
  if (S.view.kind === 'tab' && S.view.id === id) {
    const next = S.tabs[Math.min(i, S.tabs.length - 1)];
    void t;
    S.view = next ? { kind: 'tab', id: next.id } : { kind: 'none' };
  }
  if (S.panelKey === `tab:${id}`) S.panelKey = null;
  save();
  render();
}

function stepTab(d: number): void {
  if (!S.tabs.length) return;
  const cur = tabOfView();
  const i = cur ? S.tabs.indexOf(cur) : -1;
  const n = S.tabs[(i + d + S.tabs.length) % S.tabs.length];
  setView({ kind: 'tab', id: n.id });
}

// ---------------------------------------------------------------- middle

// The strip works like any terminal's (2026-11-07: "if I select on other
// tab at the top the ravenry tab disappears"): a session or a pane comes to
// the front as a tab, which stays until it is closed; clicking a tab only
// brings it to the front. Here, the one place every caller goes through.
function setView(v: View): void {
  if (v.kind === 'session') v = { kind: 'tab', id: tabForSession(v.key, v.pane) };
  else if (v.kind === 'pane') v = { kind: 'tab', id: tabForPane(v.socket, v.pane, v.name) };
  if (v.kind !== 'start') npmAsked = null;
  if (S.view.kind === 'page' && v.kind !== 'page') pages.close();
  if (S.view.kind === 'machines' && v.kind !== 'machines') machinesView.hide();
  if (v.kind !== 'review' && S.view.kind === 'review') review.key = null;
  S.view = v;
  const sk = viewSessionKey();
  const sf = sk ? findSession(S.hub, sk) : null;
  if (sf) lastSessionProject = sf.project.id;
  save();
  render();
}

/** The tab that shows this session (the shell tab of its pane, else its own), added at the end if none does. */
function tabForSession(key: string, pane?: string): string {
  const f = findSession(S.hub, key);
  const p = (f ? paneOf(f.session) : null) || pane || null;
  const had = S.tabs.find((t) => (t.kind === 'session' && t.key === key) || (!!p && t.kind === 'shell' && t.pane === p));
  if (had) { if (had.kind === 'session' && pane && !had.pane) had.pane = pane; return had.id; }
  // Its id from its key, unless a tab (renamed since) already has that one.
  const id = S.tabs.some((x) => x.id === pinId(key)) ? `${pinId(key)}#${Date.now().toString(36)}` : pinId(key);
  const t: SessionTab = { id, kind: 'session', key, ...(pane ? { pane } : {}) };
  S.tabs.push(t);
  return t.id;
}

/** The tab of a pane (a command's run), added at the end if none shows it. */
function tabForPane(socket: string, pane: string, name: string): string {
  const had = S.tabs.find((t) => t.kind === 'shell' && t.pane === pane);
  if (had) return had.id;
  const t: ShellTab = { id: shellId(pane), kind: 'shell', socket, pane, name };
  S.tabs.push(t);
  return t.id;
}

function show(id: 'term' | 'elsewhere' | 'start' | 'none' | 'review'): void {
  for (const k of ['term', 'elsewhere', 'start', 'none', 'review']) ($(k) as HTMLElement).hidden = k !== id;
  if (id !== 'term') film.close();
  $('centre').classList.toggle('sheet', id === 'start' || id === 'none');
}

/** A card that asked for the keyboard gets it, after the terminal took it. */
function focusPending(): void {
  const id = S.focusCp;
  if (!id) return;
  S.focusCp = null;
  requestAnimationFrame(() => focusCard(id));
}

let shownKey = '';
// A step of showing a pane that does not answer fails with what it was
// doing, never waits for ever with the last pane left on screen.
function within<T>(p: Promise<T>, ms: number, doing: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no answer after ${ms / 1000} s while ${doing}`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function showPane(key: string, get: () => Promise<RavenryClient | null>, pane: string, gone: (e: Error) => void): Promise<void> {
  show('term');
  // Only when that very pane is on screen: an attempt that failed or hung
  // must not leave the pane before it there and make later clicks no-ops.
  if (shownKey === key && term.attached && term.attached.pane === pane && term.ready) { focusPending(); return; }
  shownKey = key;
  try {
    const client = await within(get(), 8000, 'looking for the daemon that holds it');
    if (!client) throw new Error('no running daemon holds its pane');
    if (shownKey !== key) return;
    await within(term.show({ client, pane }), 8000, `attaching to pane ${pane}`);
  } catch (e) {
    if (shownKey !== key) return;
    shownKey = '';
    term.hide();
    const why = (e as Error).message || String(e);
    api().log(`window: could not show pane ${pane}: ${why}`);
    gone(e as Error);
  }
  focusPending();
}

async function renderCentre(): Promise<void> {
  const v = S.view;
  toastFollows(viewKey(v));
  const need = npmNeed();
  const onPage = v.kind === 'page' && !need;
  const onMachines = v.kind === 'machines' && !need;
  $('centre').hidden = WIDE_VIEWS.has(v.kind) && !need;
  $('page').hidden = !onPage;
  $('machines').hidden = !onMachines;
  $('decisions').hidden = v.kind !== 'decisions' || !!need;
  $('picker').hidden = v.kind !== 'picker' || !!need;
  $('grid').hidden = v.kind !== 'grid' || !!need;
  if (WIDE_VIEWS.has(v.kind)) { film.close(); }
  if (need) { term.hide(); shownKey = ''; show('start'); renderStart(); return; }
  if (onPage) { term.hide(); shownKey = ''; pages.show(v.key); return; }
  if (onMachines) { term.hide(); shownKey = ''; machinesView.show(); return; }
  if (v.kind === 'decisions') { term.hide(); shownKey = ''; decisions.render(); return; }
  if (v.kind === 'picker') {
    term.hide(); shownKey = '';
    const k = S.cps.get(v.cp);
    if (!k) { setView(v.back); return; }
    picker.show(k);
    return;
  }
  if (v.kind === 'grid') {
    term.hide(); shownKey = '';
    const p = (S.hub?.projects || []).find((x) => x.id === v.project);
    files.grid($('grid'), v.project, p ? p.name : v.project, () => setView(v.back));
    return;
  }
  if (v.kind === 'review') {
    const f = findSession(S.hub, v.key);
    if (!f || !f.session.worktree) { setView({ kind: 'session', key: v.key }); return; }
    term.hide(); shownKey = '';
    show('review');
    review.show(v.key, f.project, f.session);
    renderStrip();
    return;
  }
  if (npmTakesCentre() || firstRun() || v.kind === 'start') { term.hide(); shownKey = ''; show('start'); renderStart(); return; }
  if (v.kind === 'none') { term.hide(); shownKey = ''; show('none'); renderNone(); focusPending(); return; }
  if (v.kind === 'pane') {
    await showPane(`pane|${v.socket}|${v.pane}`, () => daemons.get(v.socket), v.pane, (e) => { setView(S.tabs[0] ? { kind: 'tab', id: S.tabs[0].id } : { kind: 'none' }); toast(`That pane is gone: ${e.message}`); });
    return;
  }
  const t = tabOfView();
  if (t && t.kind === 'shell') {
    // A shell whose daemon did not answer in time stays a tab: only one that is gone closes.
    await showPane(`${t.socket}|${t.pane}`, () => daemons.get(t.socket), t.pane, (e) => { if (/^no answer after/.test(e.message)) { toast(`Could not show that shell: ${e.message}`); return; } removeTab(t.id); if (!replacedPanes.has(t.pane)) toast(`That shell is gone: ${e.message}`); });
    return;
  }
  const key = viewSessionKey();
  const f = key ? findSession(S.hub, key) : null;
  const pane = f ? paneOf(f.session) : v.kind === 'session' ? v.pane || null : t && t.kind === 'session' ? t.pane || null : null;
  if (pane && (!f || !machineOf(f.project, f.session))) {
    // A session the hub runs in a ravenryd pane here shows its pane.
    // Gone: said once, and a shell in front (one opened if none is), so the
    // middle never keeps asking for a pane that is not there.
    await showPane(`session|${pane}`, () => daemons.holding(pane), pane, (e) => {
      if (!replacedPanes.has(pane)) toast(`Could not show that session: ${e.message}`);
      const front = tabOfView();
      if (!front || front.kind !== 'session' || viewSessionKey() !== key) return;
      // Its tab goes (its pane is gone); a shell comes to the front.
      removeTab(front.id);
      const sh = S.tabs.find((x) => x.kind === 'shell');
      if (sh) setView({ kind: 'tab', id: sh.id }); else void newShell();
    });
    return;
  }
  term.hide();
  shownKey = '';
  show('elsewhere');
  renderElsewhere(f, key);
  focusPending();
}

function renderNone(): void {
  replace($('none'), h('div.none-card',
    h('p', 'No shell is open.'),
    h('div.row', h('button.btn.pri', { on: { click: () => void newShell() } }, 'New shell'), h('span.t3', shortcut('T')))));
}

// A session in a terminal outside Ravenry (cmux, iTerm2, Rex, another):
// its discussion in the middle, read only, live from its screen when the
// hub reads that terminal, else from its transcript with one line saying
// why; "Open in <terminal>" focuses its tab; Move here ends it there (when
// it still runs, and once its turn is over) and resumes it in a pane here
// (moveTo): never two processes on one session. The last one shown is kept,
// so a session that ends there (its SessionEnd takes it off the board)
// still offers it.
const ELSE_OPEN = new Set(['cmux', 'iterm', 'rex']);
let elseLast: { key: string; project: HubProject; session: HubSession } | null = null;
const live = { surface: null as string | null, ver: 0, entries: null as LiveEntry[] | null, timer: 0 as unknown as ReturnType<typeof setTimeout> | 0 };

function renderElsewhere(f: { project: HubProject; session: HubSession } | null, key: string | null): void {
  let ended = false;
  if (!f && key && elseLast && elseLast.key === key && elseLast.session.sessionId) {
    // Its tab id changed (the hub found or lost its tab): the same session
    // under its new key. Else it ended there.
    const sid = elseLast.session.sessionId;
    const again = (S.hub?.projects || []).flatMap((p) => p.sessions.map((s) => ({ project: p, session: s }))).find((x) => x.session.sessionId === sid);
    if (again) {
      key = sessionKey(again.project.id, again.session);
      const t = tabOfView();
      if (t && t.kind === 'session') t.key = key; else S.view = { kind: 'tab', id: tabForSession(key) };
      f = again;
    } else if (elseLast.session.outside) { f = elseLast; ended = true; }
  }
  if (f && key && !ended) elseLast = { key, ...f };
  if (!f || !key) { liveStop(); replace($('elsewhere'), h('div.none-card', h('p', 'That session has ended.'))); return; }
  const { project, session } = f;
  const m = machineOf(project, session);
  const where = m ? `a terminal on ${m}` : session.termName || 'another terminal';
  const out = session.outside || null;
  const open = !ended && !!out && out.open !== false;
  const canOpen = !m && !ended && !!session.term && ELSE_OPEN.has(session.term);
  const kindOk = /^(claude|codex)/.test(String(session.assistant || 'claude'));
  const canResume = !!out && !!session.sessionId && kindOk && (open || out.resumable || ended);
  const busy = moveBusy.has(session.sessionId || '');
  const waiting = !!session.moving?.waiting || moveAsked.has(session.sessionId || '');
  const folder = project.folderShort ? `, in ${project.folderShort}` : '';
  const sub = ended || (out && !open) ? `Ran in ${where}${folder}. It ended there.` : `Runs in ${where}${folder}.`;
  const readable = !ended && session.terminal !== false && !session.surfaceId.startsWith('ev:');
  if (readable) liveFollow(session.surfaceId); else liveStop();
  // Its screen when it has something on it; else its transcript fills the
  // middle (a screen it cannot read, or an empty one), never a big empty area.
  const liveNow = readable && live.surface === session.surfaceId && live.entries ? live.entries.length : null;
  const showLive = readable && (!!liveNow || !(session.conversation || []).length);
  const note = out && canResume
    ? waiting
      ? h('div.else-note', svg(I.CLOCK), h('span', `Moves here when ${assistantName(session.assistant) || 'the assistant'} finishes its turn in ${where}.`))
      : h('div.else-note.ok', svg(I.DONE), h('span', open ? `Move here ends it in ${where} and picks up this conversation in a pane here.` : 'Move here picks up this conversation in a pane here.'))
    : null;
  // Why its screen is not shown, while it still runs there.
  const why = !readable && session.cannot && open ? h('p.else-why', session.cannot) : null;
  const old = $('elsewhere').querySelector('.else-disc');
  const atBottom = !old || old.scrollHeight - old.scrollTop - old.clientHeight < 40;
  const keep = old ? old.scrollTop : 0;
  replace($('elsewhere'),
    h('div.else-head',
      h('div', h('div.else-t', session.topic || project.name), h('div.t2', sub)),
      h('div.else-acts',
        canOpen ? h('button.btn', { on: { click: () => void hubOpen(project, session) } }, `Open in ${where}`) : null,
        out && waiting ? h('button.btn', { disabled: true }, `Waiting for ${assistantName(session.assistant) || 'the assistant'} to finish in ${where}`) : null,
        out && !waiting ? h(`button.btn${canResume ? '.pri' : ''}`, { disabled: !canResume || busy, title: canResume ? 'Continue this conversation in a Ravenry pane' : 'It cannot be resumed here', on: { click: () => void moveTo(project, session, 'ravenry', 'outside view') } }, busy ? 'Moving...' : 'Move here') : null)),
    note, why,
    h('div.else-disc', showLive ? discussionLive(session) : discussionFromTranscript(session, readable && liveNow === 0 ? `Its screen in ${where} is empty` : null)));
  const sc = $('elsewhere').querySelector('.else-disc');
  if (sc) sc.scrollTop = atBottom ? sc.scrollHeight : keep;
}

interface LiveEntry { k: string; l?: string[]; n?: string; a?: string; m?: number; b?: string; x?: number; t?: string; g?: string; orphan?: boolean }

/** One discussion row: a glyph and its text, as the board's Live screen draws them. */
function discRow(cls: string, glyph: string, body: (HTMLElement | string | null)[] | string): HTMLElement {
  return h(`div.dr.${cls}`, h('span.g', glyph), h('span.x', ...(Array.isArray(body) ? body : [body])));
}

function discussionLive(session: HubSession): (HTMLElement | null)[] {
  const entries = live.surface === session.surfaceId && live.entries ? live.entries : null;
  const cap = h('div.else-cap', `Live from ${session.termName || 'its terminal'}, read only`);
  if (!entries) {
    const lines = (session.screen || []).join('\n').replace(/\s+$/, '');
    return [cap, lines ? h('pre.else-screen', lines) : h('p.t3', `Reading its screen in ${session.termName || 'its terminal'}...`)];
  }
  const rows = entries.map((e) => {
    const text = (e.l || []).join('\n');
    if (e.k === 'u') return discRow('u', '❯', text);
    if (e.k === 'c') return discRow('c', e.orphan ? ' ' : '⏺', text);
    if (e.k === 'r') return discRow('s', '※', `recap: ${text}`);
    if (e.k === 's') return discRow('s', e.g || '✻', e.t || '');
    if (e.k === 'o') return discRow('s', '⎿', e.t || '');
    if (e.k === 't') return discRow('t', '⏺', e.b ? [e.b, e.x && e.x > 1 ? h('span.lv-more', ` ×${e.x}`) : null] : [h('b', e.n || ''), ` ${e.a || ''}`, e.m ? h('span.lv-more', ` +${e.m} line${e.m > 1 ? 's' : ''}`) : null]);
    return discRow('p', ' ', text);
  });
  return [cap, ...(rows.length ? rows : [h('p.t3', 'Its screen is empty.')])];
}

function discussionFromTranscript(session: HubSession, why: string | null = null): (HTMLElement | null)[] {
  const conv = session.conversation || [];
  if (!conv.length) return [h('p.t3', why ? `${why}, and its transcript has no finished turn yet.` : 'Its transcript has no finished turn yet.')];
  const rows: HTMLElement[] = [];
  for (const t of conv) {
    if (t.ask) rows.push(discRow('u', '❯', t.ask));
    if (t.text) rows.push(discRow('c', '⏺', t.text));
    if (t.working) rows.push(discRow('s', '✻', 'Working...'));
  }
  return [h('div.else-cap', why ? `From its transcript (${why.charAt(0).toLowerCase()}${why.slice(1)})` : 'From its transcript'), ...rows];
}

/** Reads the session's screen through the hub's Live screen while it is in the middle. */
function liveFollow(surface: string): void {
  if (live.surface === surface && live.timer) return;
  liveStop();
  live.surface = surface;
  const poll = async (): Promise<void> => {
    if (live.surface !== surface) return;
    try {
      const r = await api().hubGet(`/api/live?surface=${encodeURIComponent(surface)}${live.ver ? `&v=${live.ver}` : ''}`) as { ver?: number; same?: boolean; entries?: LiveEntry[] };
      if (live.surface !== surface) return;
      if (!r.same && r.entries) {
        live.ver = r.ver || 0;
        live.entries = r.entries;
        if (S.view.kind === 'session' || S.view.kind === 'tab') void renderCentre();
      }
    } catch { /* the hub reads it again next time */ }
    if (live.surface === surface) live.timer = setTimeout(() => void poll(), 1500);
  };
  live.timer = setTimeout(() => void poll(), 0);
}

function liveStop(): void {
  if (live.timer) clearTimeout(live.timer);
  live.timer = 0;
  live.surface = null;
  live.ver = 0;
  live.entries = null;
}

async function hubOpen(p: HubProject, s: HubSession): Promise<void> {
  const at = here();
  try { await api().hubPost('/api/open', { projectId: p.id, surfaceId: s.surfaceId }); } catch (e) { toast((e as Error).message, undefined, { at, error: true }); }
}

// ---------------------------------------------------------------- first launch

async function loadStart(): Promise<void> {
  const [found, assistants] = await Promise.all([api().folders(), api().assistants()]);
  let folders = found.folders;
  // Folders the board already knows come first.
  try {
    if (S.hubStatus?.reachable) {
      const r = await api().hubGet('/api/project/folders') as { folders?: { name?: string; folder?: string; path?: string }[] };
      const known: FolderPick[] = [];
      for (const x of r.folders || []) {
        const p = x.folder || x.path;
        if (p) known.push({ name: x.name || base(p), path: p, short: await api().shortPath(p) });
      }
      folders = [...known, ...folders.filter((f) => !known.some((k) => k.path === f.path))].slice(0, 5);
    }
  } catch { /* the board has none to offer */ }
  S.start.folders = folders;
  S.start.root = found.root ? await api().shortPath(found.root) : null;
  if (!S.start.folder || !folders.some((f) => f.path === S.start.folder)) S.start.folder = folders[0]?.path || S.start.folder;
  S.start.assistants = assistants;
  const ready = assistants.find((a) => a.found && a.signedIn) || assistants.find((a) => a.found);
  if (!S.start.assistant || !assistants.some((a) => a.kind === S.start.assistant && a.found)) S.start.assistant = ready ? ready.kind : null;
  void checkHooks();
  if (firstRun() || S.view.kind === 'start') renderStart();
}

/**
 * The assistants' hooks: when the board would change Claude Code's or
 * Codex's settings to report through ravenryd (a dry run says), the start
 * screen asks once, in plain words, with a Skip.
 */
async function checkHooks(): Promise<void> {
  const hk = S.hooks;
  if (hk.asked || hk.checked || !S.hubStatus?.reachable || !S.config?.hookBin) return;
  hk.checked = true;
  try {
    const r = await api().hubPost('/api/setup/hooks', { ravenryd: S.config.hookBin, dry: true }) as { claude?: { file?: string; changes?: unknown[] } | null; codex?: { file?: string; changes?: unknown[] } | null };
    const which = ([['Claude Code', r.claude], ['Codex', r.codex]] as const).filter(([, x]) => x && x.changes && x.changes.length && x.file);
    hk.offer = which.length ? { names: which.map(([n]) => n), files: which.map(([, x]) => tilde(x!.file)) } : null;
  } catch { hk.offer = null; }
  if (firstRun() || S.view.kind === 'start') renderStart();
}

async function setUpHooks(yes: boolean): Promise<void> {
  const hk = S.hooks;
  if (!yes) { hk.asked = true; hk.offer = null; api().storeSet({ hooksAsked: true }); renderStart(); return; }
  hk.busy = true; hk.error = null; renderStart();
  const at = here();
  try {
    await api().hubPost('/api/setup/hooks', { ravenryd: S.config!.hookBin });
    const names = hk.offer?.names || ['Claude Code'];
    hk.asked = true; hk.offer = null; api().storeSet({ hooksAsked: true });
    toast(`${names.join(' and ')} now ${names.length > 1 ? 'tell' : 'tells'} Ravenry when ${names.length > 1 ? 'they need' : 'it needs'} you. The old settings were backed up.`, undefined, { at, error: false });
  } catch (e) {
    hk.error = `Could not set them up: ${(e as Error).message}`;
  } finally {
    hk.busy = false;
    renderStart();
  }
}

function openStart(): void {
  if (npmPoint('Starting a session')) return;
  S.start.error = null;
  setView({ kind: 'start' });
  void loadStart();
}

function renderStart(): void {
  // The switch from the npm board takes the first-launch place (npmswitch.ts).
  if (npmTakesCentre()) { renderNpmCentre($('start')); return; }
  // The hub waits for macOS to say whether it may read a folder.
  if (S.hubStatus?.starting) { replace($('start'), accessCard(S.hubStatus.starting)); return; }
  const need = npmNeed();
  if (need) { renderNpmPointer($('start'), need, { url: S.config?.hubUrl || 'http://localhost:4600', reachable: !!S.hubStatus?.reachable, newShell: () => void newShell(), openUrl: (u) => api().openExternal(u) }); return; }
  const st = S.start;
  const first = firstRun();
  const folderName = st.folder ? base(st.folder) : null;
  const a = st.assistants.find((x) => x.kind === st.assistant) || null;
  const anyFound = st.assistants.some((x) => x.found);
  const picks = st.folders.slice(0, 3);
  if (st.folder && !picks.some((f) => f.path === st.folder)) {
    const extra = st.folders.find((f) => f.path === st.folder) || { name: base(st.folder), path: st.folder, short: st.folder };
    picks.unshift(extra);
  }

  const folderRow = h('div.fl-r',
    h(`span.fl-n${st.folder ? '.ok' : ''}`, '1'),
    h('div.fl-c',
      h('span.h', 'Folder'),
      picks.length ? h('div.fold', picks.map((f) => h(`button.fo${f.path === st.folder ? '.on' : ''}`, { on: { click: () => { st.folder = f.path; renderStart(); } } },
        h('span.radio', h('i')), f.name, h('span.m', f.short)))) : null,
      h('span.t3.small', st.root && picks.length ? `Found in ${st.root}. ` : '', h('button.link', { on: { click: () => void chooseFolder() } }, 'Choose another folder'), ' or drop one here.')));

  const asstRow = h('div.fl-r',
    h(`span.fl-n${a ? '.ok' : ''}`, '2'),
    h('div.fl-c',
      h('span.h', 'Assistant'),
      anyFound
        ? h('div.pick', st.assistants.map((x) => h(`button.pk${x.kind === st.assistant ? '.on' : ''}`, { disabled: !x.found, on: { click: () => { st.assistant = x.kind; renderStart(); } } },
          h('span.h', x.name),
          h('span.s', h(`i.${x.found && x.signedIn ? 'ok' : x.found ? 'warn' : 'no'}`), x.found ? (x.signedIn ? 'Found, signed in' : 'Found, not signed in yet') : `Not on ${isMac() ? 'this Mac' : 'this computer'}`))))
        : h('p.t2.small', 'Neither Claude Code nor Codex is installed here yet. Install one, then come back. A plain shell works meanwhile.')));

  const label = a && folderName ? `Start ${assistantName(a.kind)} in ${folderName}` : folderName ? `Open a shell in ${folderName}` : 'Open a shell';
  // 33 B: when another session already works in that folder, the new one
  // gets its own copy of the code, and one line says why.
  const busy = a ? busyIn(st.folder) : null;
  const why = busy ? h('div.fl-why', svg(I.BRANCH),
    h('div', st.inFolder
      ? [h('b', 'It works right in the folder'), `, beside ${busy.topic}, so they share the files. `, h('button.link', { on: { click: () => { st.inFolder = false; renderStart(); } } }, 'Give it its own copy instead')]
      : [h('b', 'It gets its own copy of the code'), `, on a new branch, because ${busy.topic} is already working in ${busy.project.name}. You review and merge it when it's done. `, h('button.link', { on: { click: () => { st.inFolder = true; renderStart(); } } }, 'Work in the folder instead')])) : null;
  const go = h('div.fl-go',
    h('button.btn.pri', { disabled: st.busy, on: { click: () => void startSession() } }, label),
    h('span.t3.small', `${shortcut('N')} starts another one any time`),
    !first ? h('span.sp') : null,
    !first ? h('button.btn.ghost', { on: { click: () => { const t = S.tabs[0]; setView(t ? { kind: 'tab', id: t.id } : { kind: 'none' }); } } }, 'Cancel') : null);

  const hk = S.hooks;
  const hooksCard = hk.offer && !hk.asked ? h('div.fl-hooks',
    h('div.fl-c',
      h('span.h', `Let ${hk.offer.names.join(' and ')} tell Ravenry when ${hk.offer.names.length > 1 ? 'they need' : 'it needs'} you`),
      h('p.t2.small', `Ravenry adds its own line to the hooks in ${hk.offer.files.join(' and ')}, so the sessions here say when they wait for you or hand off. Each file is backed up first, and your other hooks stay as they are.`),
      hk.error ? h('p.err', hk.error) : null),
    h('div.fl-hb',
      h('button.btn.pri.sm', { disabled: hk.busy, on: { click: () => void setUpHooks(true) } }, 'Set them up'),
      h('button.btn.ghost.sm', { disabled: hk.busy, on: { click: () => void setUpHooks(false) } }, 'Skip'))) : null;

  const card = h('div.fl-card', { on: { dragover: (e: Event) => e.preventDefault(), drop: (e: Event) => onDrop(e as DragEvent) } }, folderRow, asstRow, why, go);
  replace($('start'), h('div.fl',
    svg(I.APP_ICON),
    h('h2', first ? 'Start your first session' : 'Start a session'),
    h('p.lead', 'Pick a folder and an assistant. It opens in a real terminal here, and the list on the left keeps every session in order, the ones that need you first.'),
    card,
    st.error ? h('p.err', st.error) : null,
    hooksCard,
    h('div.fl-foot', 'Keeping cmux, iTerm2 or Rex? Ravenry still follows the sessions you run there.')));
}

/** A session already working in a folder's project here, if any (33 B decides a worktree then). */
function busyIn(folder: string | null): { project: HubProject; topic: string } | null {
  if (!folder) return null;
  for (const p of S.hub?.projects || []) {
    if (!p.folder || (folder !== p.folder && !folder.startsWith(p.folder + '/')) || p.machine) continue;
    const s = p.sessions.find((x) => !x.handed && !machineOf(p, x) && sessionGroup(x) !== 'idle' && !(x.worktree && x.worktree.state === 'open'));
    if (s) return { project: p, topic: s.topic || p.name };
  }
  return null;
}

async function chooseFolder(): Promise<void> {
  const p = await api().chooseFolder();
  if (p) { S.start.folder = p; renderStart(); }
}

function onDrop(e: DragEvent): void {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  const p = api().pathForFile(f);
  if (p) { S.start.folder = p; renderStart(); }
}

// macOS's privacy question, said in the window while the hub waits for the
// answer (hub/server/access.mjs): the dialog is easy to miss, or was closed.
const PRIVACY_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders';
function accessCard(st: { waitingFor: string | null; folder: string | null }): HTMLElement {
  if (!st.waitingFor) return h('div.access-card', h('p.ac-t', 'The board is starting.'));
  return h('div.access-card',
    h('p.ac-t', `macOS is asking whether Ravenry may read ${st.waitingFor}. Click Allow in the dialog.`),
    h('p.ac-s', `Closed the dialog? Open System Settings > Privacy & Security > Files & Folders, find Ravenry and turn on ${st.folder || st.waitingFor}. The board starts by itself once it may read it.`),
    h('div.row', h('button.btn', { on: { click: () => api().openExternal(PRIVACY_PANE) } }, 'Open Files & Folders')));
}

async function startSession(): Promise<void> {
  const st = S.start;
  st.busy = true;
  st.error = null;
  renderStart();
  try {
    const a = st.assistants.find((x) => x.kind === st.assistant && x.found) || null;
    const { cols, rows } = term.term;
    if (a && S.hubStatus?.reachable) {
      // The board starts it in a ravenryd pane, so its hooks, brief and
      // hand-off apply, and it shows in the sidebar.
      // The hub answers with the pane itself (hub/docs/TERMINALS.md), not its id.
      const busy = busyIn(st.folder);
      const own = busy && !st.inFolder ? { worktree: true, projectId: busy.project.id } : {};
      const r = await api().hubPost('/api/sessions/start', { folder: st.folder || S.config?.home, assistant: a.kind, cols, rows, ...own }) as { surfaceId?: string; pane?: { id?: string }; projectId?: string | null };
      const pane = r.pane && typeof r.pane.id === 'string' ? r.pane.id : null;
      setView({ kind: 'session', key: r.projectId && r.surfaceId ? `${r.projectId}/${r.surfaceId}` : '', ...(pane ? { pane } : {}) });
      return;
    }
    // No board: the assistant (or a shell) in a pane of the app's own.
    const { client, socket } = await daemons.forNew();
    const { pane } = await client.request('pane.new', {
      cols, rows,
      labels: { ...SHELL_LABEL, ...(a ? { 'ravenry.agent': a.kind } : {}) },
      ...(st.folder ? { cwd: st.folder } : {}),
      ...(a ? { command: [a.path || a.kind], name: a.name } : { name: 'Shell', ...(S.config?.newShell ? { command: S.config.newShell } : {}) }),
    });
    addShellTab(socket, pane, a ? a.kind : null, true);
  } catch (e) {
    st.error = `Could not start it: ${(e as Error).message}`;
  } finally {
    st.busy = false;
    if (S.view.kind === 'start' || firstRun()) renderStart();
  }
}

// ---------------------------------------------------------------- panel

function panelVisible(): boolean {
  if (npmTakesCentre() || firstRun() || S.view.kind === 'start') return false;
  if (S.overlay) return true;
  // A page takes the right column too; a checkpoint it opened comes over it.
  if (WIDE_VIEWS.has(S.view.kind)) return false;
  return wide() && S.panelPref !== 'closed';
}

function togglePanel(): void {
  if (S.overlay) { S.overlay = false; S.panelKey = null; }
  else if (wide()) S.panelPref = panelVisible() ? 'closed' : null;
  else S.overlay = true;
  save();
  render();
}

/** What the panel shows, as panelKey names it. */
function panelTargetKey(): string | null {
  if (S.panelKey && S.panelKey.startsWith('cp:')) return S.panelKey;
  const key = viewSessionKey();
  if (key && findSession(S.hub, key)) return key;
  const t = tabOfView();
  return t && t.kind === 'shell' ? `tab:${t.id}` : key;
}

const panelBody = h('div.p-b');

function renderPanel(): void {
  const el = $('panel');
  const vis = panelVisible();
  el.hidden = !vis;
  const docked = vis && !S.overlay && wide() && !WIDE_VIEWS.has(S.view.kind);
  el.classList.toggle('overlay', vis && !docked);
  if (!vis) { clearHiddenSecrets(false); return; }
  const key = panelTargetKey();
  // What the panel shows, for the release check: always what is in front,
  // and what it shows of it (session, off-board, shell, cp, none).
  el.dataset.key = key || '';
  let shows = 'none';
  let head: HTMLElement;
  let body: (HTMLElement | null)[];
  if (key && key.startsWith('tab:')) {
    const t = S.tabs.find((x): x is ShellTab => x.kind === 'shell' && x.id === key.slice(4));
    [head, body] = t ? shellPanel(t) : [panelHead('Shell', null), []];
    if (t) shows = 'shell';
  } else if (key && key.startsWith('cp:')) {
    const k = S.cps.get(key.slice(3));
    [head, body] = k ? loosePanel(k) : [panelHead('Session', null), []];
    if (k) shows = 'cp';
  } else {
    const f = key ? findSession(S.hub, key) : null;
    const last = key && !f ? lastKnown.get(key) : null;
    if (f) { [head, body] = sessionPanel(f.project, f.session, key!); shows = 'session'; }
    // Its session is off the board (it ended there, or between two states):
    // what was last known of it, never a blank "Pick a session".
    else if (last) { [head, body] = offBoardPanel(last.project, last.session); shows = 'off-board'; }
    else {
      const t = tabOfView();
      if (t && t.kind === 'shell') { [head, body] = shellPanel(t); shows = 'shell'; }
      else [head, body] = [panelHead('Session', null), [h('p.t3.small', 'Pick a session on the left to see its context, hand-off and brief here.')]];
    }
  }
  el.dataset.shows = shows;
  patch(el, [head, panelBody]);
  patch(panelBody, body);
  clearHiddenSecrets(true);
}

// The sessions of the tabs as the hub last listed them: a tab whose session
// leaves the board still shows what was known of it.
const lastKnown = new Map<string, { project: HubProject; session: HubSession }>();
function rememberTabSessions(): void {
  for (const t of S.tabs) {
    const key = t.kind === 'session' ? t.key : sessionOfPane(S.hub, t.pane)?.key;
    const f = key ? findSession(S.hub, key) : null;
    if (key && f) lastKnown.set(key, f);
  }
}

/** A session tab whose session is off the board: its name, folder, assistant, last turn, and Move here. */
function offBoardPanel(p: HubProject, s: HubSession): [HTMLElement, (HTMLElement | null)[]] {
  const where = s.termName || (s.term === 'ravenry' ? 'Ravenry' : 'its terminal');
  const conv = s.conversation || [];
  const lastTurn = conv.length ? conv[conv.length - 1] : null;
  const canMove = !!s.sessionId && /^(claude|codex)/.test(String(s.assistant || 'claude')) && !s.surfaceId.startsWith('ravenry:');
  return [panelHead(p.name, assistantName(s.assistant), null, machineOf(p, s)), [
    h('div.st.c-idle', svg(RING.idle), `Not running now${s.term && s.term !== 'ravenry' ? `: it ran in ${where}` : ''}`),
    h('div.sec', h('p', s.topic || p.name), p.folderShort ? h('p.t3.small', p.folderShort) : null),
    lastTurn ? h('div.sec', lastTurn.ask ? h('p.t3.small', `You: ${lastTurn.ask.length > 140 ? lastTurn.ask.slice(0, 139) + '...' : lastTurn.ask}`) : null, lastTurn.text ? h('p', lastTurn.text.length > 240 ? lastTurn.text.slice(0, 239) + '...' : lastTurn.text) : null) : null,
    canMove ? h('div.sec', h('p.t3.small', 'Move here picks up this conversation in a pane here.'), h('div.acts', h('button.btn.sm.pri', { on: { click: () => void moveTo(p, s, 'ravenry', 'panel, off the board') } }, 'Move here'))) : null,
  ]];
}

function panelHead(name: string, tag: string | null, extra?: HTMLElement | null, machine: string | null = null): HTMLElement {
  return h('div.p-h', h('span.n', name), machineTag(machine), tag ? h('span.as-tag', tag) : null, h('span.sp'), extra || null,
    h('button.icon-btn', { title: 'Hide', 'aria-label': 'Hide the panel', on: { click: () => togglePanel() } }, svg(I.CHEVRON)));
}

function statusLine(p: HubProject, s: HubSession, k: Known | null): HTMLElement {
  if (k && isOpen(k.cp)) return h('div.st.c-you', svg(RING.you), `Needs you since ${clock(k.cp.created_at, now())}`);
  const g = sessionGroup(s);
  const t = g === 'you' ? `Needs you since ${clock(s.since || p.since, now())}`
    : g === 'work' ? 'Working'
      : g === 'wait' ? (p.waitingOn ? `Waiting on ${p.waitingOn}` : 'Waiting on others')
        : `Idle${s.since ? ` for ${ago(s.since, now())}` : ''}`;
  return h(`div.st.c-${g}`, svg(RING[g]), t);
}

function sessionPanel(p: HubProject, s: HubSession, key: string): [HTMLElement, (HTMLElement | null)[]] {
  const g = sessionGroup(s);
  const w = s.words || {};
  const threshold = S.hub?.settings?.handoffThreshold ?? 50;
  const pinned = S.tabs.some((t) => t.kind === 'session' && t.key === key);
  const head = panelHead(p.name, assistantName(s.assistant),
    h(`button.icon-btn.sm${pinned ? '.on' : ''}`, { title: pinned ? 'Unpin from the tabs' : 'Pin to the tabs', 'aria-label': 'Pin', on: { click: () => togglePin(key) } }, svg(I.PIN)), machineOf(p, s));
  const k = cpOfSession(p, s);
  const body: (HTMLElement | null)[] = [statusLine(p, s, k)];
  // The same session runs in another terminal too (cmux's restore started
  // it again there), or went on there: one click puts it in one place.
  if (s.alsoOpen || s.movedOn) {
    const other = s.alsoOpen ? s.alsoOpen.name : s.movedOn!.name;
    body.push(h('div.sec.twin', h('p', s.alsoOpen ? `Also open in ${other}.` : `This conversation went on in ${other}.`),
      h('div.acts', ...moveActs(p, s, other, s.alsoOpen ? 'double open, panel' : 'went on elsewhere, panel', !!s.alsoOpen))));
  }

  if (k) body.push(cardFor(k, cardCtx));
  // Over the terminal on a narrow window, a card keeps the panel short: it and the context.
  const lean = !!k && isOpen(k.cp) && S.overlay;
  // The card replaces the plain question box, and a box with nothing to say is left out.
  const q0 = w.headline || w.question || w.line || '';
  if (!k && g === 'you' && (q0 || (w.dialog && w.dialog.length) || (w.quick || []).length)) {
    const q = q0;
    const quick = (w.quick || []).slice(0, 6);
    body.push(h('div.sec.ask',
      q ? h('p.q', q) : null,
      w.dialog && w.dialog.length ? h('pre.dlg', w.dialog.join('\n')) : null,
      quick.length ? h('div.qa', quick.map((o) => h('button.btn.sm', { on: { click: () => void answer(p, s, o.label, o.choice) } }, o.label))) : null));
  }

  const ap = paneOf(s);
  if (ap && !machineOf(p, s) && !lean) {
    body.push(...sessionExtras(p, s, ap));
  }

  if (s.ctx) {
    const pct = Math.max(0, Math.min(100, s.ctx.pct));
    body.push(h('div.sec',
      h('div.sec-h', 'Context', h('span.sp'), h('span.num.strong', `${tokens(s.ctx.tokens)} of ${tokens(s.ctx.window)}`)),
      h('div.bar', h('div.f', { style: { width: `${pct}%`, background: pct >= threshold ? 'var(--you)' : 'var(--tx2)' } }), h('div.m', { style: { left: `${threshold}%` }, title: `Hand-off line at ${threshold}%` })),
      h('div.row', h('span.t3.small.grow', `Hands off at ${threshold}%`), h('button.btn.sm', { on: { click: () => void handOff(p, s) } }, 'Hand off now'))));
  }

  if (lean) return [head, body];

  const ho = (p.timeline || []).find((x) => x.from === 'brief');
  if (ho) {
    body.push(h('div.sec',
      h('div.sec-h', 'Hand-off', h('span.sp'), ho.when ? h('span.t3.light', ho.when) : null),
      h('p', ho.text),
      p.handoffRecent ? h('div.chk', h('i', svg(I.CHECK)), 'Read by this session') : null));
  }

  const pics = p.brief?.pictures || [];
  const pic = pics.filter((x) => x.url).slice(-1)[0];
  if (pic && S.config) {
    body.push(h('div.sec',
      h('div.sec-h', 'Latest picture', h('span.sp'), h('button.lk', { on: { click: () => openBoard(`#${p.id}`) } }, 'Gallery')),
      h('img.shot', { src: S.config.hubUrl + pic.url, alt: pic.alt || 'The latest picture this session showed' }),
      pic.alt ? h('span.t3.small', pic.alt) : null));
  }

  if (p.brief && (p.brief.goal || p.brief.next)) {
    body.push(h('div.sec',
      h('div.sec-h', 'Brief', h('span.sp'), h('button.lk', { on: { click: () => openBoard(`#${p.id}`) } }, 'Edit')),
      h('div.kv', p.brief.goal ? [h('span', 'Goal'), briefValue(p.id, 'goal', p.brief.goal)] : null, p.brief.next ? [h('span', 'Next'), briefValue(p.id, 'next', p.brief.next)] : null)));
  }

  const plan = p.plan;
  body.push(h('div.sec',
    h('div.sec-h', 'Plan', h('span.sp'), h('span.t3.light', plan ? (p.planGate ? 'At a gate' : 'Running') : 'None running')),
    plan ? h('p', plan.title || plan.name || 'A plan is running.') : h('p.t2.small', 'Hand work over as steps; it runs on its own and stops at your gates.'),
    h('button.btn.sm.self', { on: { click: () => openBoard(plan ? `#/plan/${p.id}` : `#${p.id}`) } }, plan ? 'Open the plan' : 'New plan')));

  return [head, body];
}

// A brief field in the panel: about four lines, with Show all when there is
// more (and Show less once open). Which fields are open is kept per project
// while the window lives, so a new state from the hub does not fold them.
const briefOpen = new Set<string>();
function briefValue(projectId: string, field: string, text: string): HTMLElement {
  const k = `${projectId}\u0000${field}`;
  const open = briefOpen.has(k);
  const body = h(`span.bv${open ? '' : '.clamp'}`, text);
  const toggle = h('button.lk.bv-more', { hidden: !open, on: { click: () => { if (briefOpen.has(k)) briefOpen.delete(k); else briefOpen.add(k); renderPanel(); } } }, open ? 'Show less' : 'Show all');
  // Folded: Show all only when the text runs past its four lines.
  if (!open) requestAnimationFrame(() => { if (body.scrollHeight > body.clientHeight + 1) toggle.hidden = false; });
  return h('span.bv-cell', body, toggle);
}

/** What a session's panel shows of Phase 2 between its card and its context. */
function sessionExtras(p: HubProject, s: HubSession, pane: string): (HTMLElement | null)[] {
  return [
    ...review.panelCards(p, s, () => setView({ kind: 'review', key: sessionKey(p.id, s) })),
    files.section(p.id, p.name, s.surfaceId),
    panesItUses(pane, paneCtx),
  ];
}

function shellPanel(t: ShellTab): [HTMLElement, (HTMLElement | null)[]] {
  const started = t.createdAt ? clock(t.createdAt, now()) : null;
  // What the agent in it reported through the daemon's status channel.
  const st = t.status;
  const k = S.cps.forPane(t.pane, null, now());
  const who = st ? assistantName(st.assistant) || 'The agent' : null;
  const needs = { permission: 'is asking for permission', question: 'has a question', auth: 'needs you to sign in', other: 'needs you' } as const;
  const stLine = k && isOpen(k.cp) ? h('div.st.c-you', svg(RING.you), `Needs you since ${clock(k.cp.created_at, now())}`)
    : !st ? null
      : st.state === 'needs_you' ? h('div.st.c-you', svg(RING.you), `${who} ${needs[st.need?.kind || 'other']}${st.since ? ` since ${clock(st.since, now())}` : ''}`)
        : st.state === 'working' ? h('div.st.c-work', svg(RING.work), `${who} is working`)
          : st.state === 'idle' ? h('div.st.c-idle', svg(RING.idle), `${who} is done with its turn`) : null;
  void started;
  const known = store.get(t.pane);
  const proj = (S.hub?.projects || []).find((p) => p.folder && t.cwd && (t.cwd === p.folder || t.cwd.startsWith(p.folder + '/')));
  const creator = known?.pane.creator;
  const tag = creator && creator.kind === 'agent' ? `${sourceOf(creator).who}'s pane` : t.agent ? null : 'Shell';
  return [
    panelHead(t.agent ? assistantName(t.agent) || 'Shell' : shellLabel(t).name, tag),
    [
      known ? openedLine(known, paneCtx, proj ? proj.name : null) : null,
      stLine,
      k ? cardFor(k, cardCtx) : null,
      !k && st?.need?.message ? h('div.sec.ask', h('p.q', st.need.message)) : null,
      known ? whoCanType(t.pane, paneCtx) : null,
      known ? typedHere(t.pane, paneCtx) : null,
      known ? null : h('div.sec',
        h('div.kv',
          h('span', 'Folder'), h('span.mono', tilde(t.cwd)),
          h('span', 'Runs'), h('span.mono', (t.command || []).join(' ') || 'your login shell'))),
    ],
  ];
}

/** A checkpoint from a pane the window does not know as a tab or a session. */
function loosePanel(k: Known): [HTMLElement, (HTMLElement | null)[]] {
  return [
    panelHead(k.cp.project || 'Waiting for you', assistantName(k.cp.assistant), null, k.cp.machine || null),
    [isOpen(k.cp) ? h('div.st.c-you', svg(RING.you), `Needs you since ${clock(k.cp.created_at, now())}`) : null, cardFor(k, cardCtx)],
  ];
}

async function answer(p: HubProject, s: HubSession, label: string, choice?: number): Promise<void> {
  const at = here();
  try {
    await api().hubPost('/api/send', { projectId: p.id, surfaceId: s.surfaceId, ...(choice == null ? { text: label } : { choice }) });
    toast(`Sent: ${label}`, undefined, { at, error: false });
  } catch (e) { toast((e as Error).message, undefined, { at, error: true }); }
}

async function handOff(p: HubProject, s: HubSession): Promise<void> {
  const at = here();
  try { await api().hubPost('/api/handoff', { projectId: p.id, surfaceId: s.surfaceId }); toast('It hands off after the current task.', undefined, { at, error: false }); } catch (e) { toast((e as Error).message, undefined, { at, error: true }); }
}

// ---------------------------------------------------------------- events

function onHubState(next: HubState): void {
  const prev = S.hub;
  S.hub = next;
  // A session that kept its id but changed its key keeps its place: the
  // middle, its pinned tab and the panel follow it.
  const moved = rekeyed(prev, next);
  if (moved.size) {
    const v = S.view;
    if (v.kind === 'session' && moved.has(v.key)) S.view = { ...v, key: moved.get(v.key)! };
    for (const t of S.tabs) if (t.kind === 'session' && moved.has(t.key)) t.key = moved.get(t.key)!;
    // One tab per session: a second one for the same session goes.
    const seen = new Set<string>();
    for (const t of [...S.tabs]) if (t.kind === 'session') { if (seen.has(t.key)) removeTab(t.id); else seen.add(t.key); }
    if (S.panelKey && moved.has(S.panelKey)) S.panelKey = moved.get(S.panelKey)!;
    if (elseLast && moved.has(elseLast.key)) elseLast.key = moved.get(elseLast.key)!;
    save();
  }
  // A move done since (after the tabs took their sessions' new keys).
  moveStates();
  rememberTabSessions();
  pages.update((next as { pages?: NavRow[] }).pages);
  machinesSaid((next as { machines?: MachineView[] }).machines);
  // A session the start screen just started: the view follows it once listed.
  const ft = tabOfView();
  if (ft && ft.kind === 'session' && ft.pane && !findSession(next, ft.key)) {
    const f = sessionOfPane(next, ft.pane);
    if (f) { ft.key = f.key; ft.id = pinId(f.key); S.view = { kind: 'tab', id: ft.id }; }
  }
  const { opened, gone } = S.cps.fromHub(next.checkpoints as HubCheckpoint[] | undefined);
  if (gone.length) void closedOnHub(gone);
  // A checkpoint or an approval arrived: the panel opens on it.
  const arrived = arrivals(prev, next);
  if (!firstRun()) {
    if (opened.length) { const k = S.cps.get(opened[opened.length - 1]); if (k) arrive(k); }
    else if (arrived.length) {
      arrivedAt(arrived[arrived.length - 1]);
    }
  }
  render();
}

/**
 * A machine whose ravenryd is older than the app's, or that will not talk,
 * is said once (per machine and version), with the way to the installer;
 * the dot on the Machines mark stays until it is updated.
 */
function machinesSaid(list: MachineView[] | undefined): void {
  machinesView.update(list);
  if (!Array.isArray(list) || firstRun()) return;
  for (const m of list) {
    if (m.job && m.job.state === 'running') continue;
    const what = m.compare === 'older' && m.version ? `${m.name} runs an older ravenryd (${m.version}).`
      : m.compare === 'protocol' ? `${m.name} runs a ravenryd this app cannot talk to${m.remote ? ` (${m.remote.version})` : ''}.` : null;
    const key = `${m.name}|${m.compare}|${m.version || (m.remote && m.remote.version) || ''}`;
    if (!what || toldMachines.has(key)) continue;
    toldMachines.add(key);
    if (S.view.kind !== 'machines') toast(what, { label: 'Update it', run: () => setView({ kind: 'machines' }) });
  }
}

function shellTabOf(socket: string, pane: string): ShellTab | undefined {
  return S.tabs.find((x): x is ShellTab => x.kind === 'shell' && x.socket === socket && x.pane === pane);
}

/** Someone asked to show a pane (pane.focus): its tab, or the session it runs. */
function focusPane(socket: string, pane: string): void {
  const t = shellTabOf(socket, pane) || S.tabs.find((x): x is ShellTab => x.kind === 'shell' && x.pane === pane);
  const f = sessionOfPane(S.hub, pane);
  if (t) setView({ kind: 'tab', id: t.id });
  else if (f) pickSession(f.key);
  else return;
  api().focusWindow();
}

function onCheckpoint(socket: string, cp: Checkpoint): void {
  const { opened } = S.cps.fromDaemon(socket, cp);
  const k = S.cps.get(cp.id);
  if (opened && k) arrive(k);
  render();
}

function onDaemonEvent(socket: string, e: DaemonEvent): void {
  store.event(socket, e);
  switch (e.event) {
    case 'pane.focus': focusPane(socket, e.pane.id); return;
    case 'checkpoint.opened': case 'checkpoint.running': case 'checkpoint.closed': onCheckpoint(socket, e.checkpoint); return;
    case 'pane.cwd': {
      // The folder a shell is in now (OSC 7), so the tab follows cd.
      const t = shellTabOf(socket, e.pane.id);
      if (t && e.pane.cwd !== t.cwd) { t.cwd = e.pane.cwd; renderTabs(); if (panelVisible()) renderPanel(); }
      return;
    }
    case 'pane.activity': {
      // A tab not on screen printed: a quiet dot on it.
      const t = shellTabOf(socket, e.pane.id);
      if (t && !t.activity && tabOfView() !== t) { t.activity = true; renderTabs(); }
      return;
    }
    case 'pane.created': case 'pane.updated': {
      // A plain shell another window or the command line made.
      if (e.pane.labels?.['ravenry.kind'] === 'shell' && e.pane.state === 'running' && !shellTabOf(socket, e.pane.id)) addShellTab(socket, e.pane, null, false);
      // An agent's own pane: a tab right after its session's, the front left alone.
      else if (agentPane(e.pane) && !shellTabOf(socket, e.pane.id)) { addAgentPaneTab(socket, e.pane); save(); render(); }
      // pane.created can come before the daemon has recorded who made the
      // pane: asked once more, from the pane list.
      else if (e.event === 'pane.created' && !e.pane.creator && e.pane.labels?.['ravenry.kind'] !== 'shell') {
        const id = e.pane.id;
        void daemons.get(socket).then((c) => c.request('pane.list', {})).then(({ panes }) => {
          const p = panes.find((x) => x.id === id);
          if (p && agentPane(p) && !shellTabOf(socket, id)) { addAgentPaneTab(socket, p); save(); render(); }
        }).catch(() => {});
      }
      return;
    }
    case 'agent.report': {
      const t = e.pane ? shellTabOf(socket, e.pane.id) : undefined;
      // The session moved on (a new tool use, a prompt, its turn ended):
      // the card of a checkpoint answered before that leaves the panel.
      if (e.pane?.agent) S.cps.settle(e.pane.id, Date.parse(e.pane.agent.at || e.pane.agent.since || '') || now());
      if (t && e.pane) { t.status = e.pane.agent || null; renderTabs(); if (panelVisible()) renderPanel(); }
      return;
    }
    case 'pane.title': case 'pane.exited': case 'pane.closed': {
      const t = shellTabOf(socket, e.pane.id);
      if (!t) return;
      if (e.event === 'pane.title') { applyPane(t, e.pane); renderTabs(); if (panelVisible()) renderPanel(); return; }
      // The shell ended: its tab goes, as in any terminal.
      removeTab(t.id);
      if (e.event === 'pane.exited') void daemons.get(socket).then((c) => c.request('pane.close', { pane: e.pane.id })).catch(() => {});
      return;
    }
  }
}

function onDaemonReady(socket: string, client: RavenryClient): void {
  void store.load(socket, client);
  // Started from inside a pane, this window is not the person to that
  // daemon: its cards show, with their buttons off.
  if (client.hello.person === false) S.notPerson.add(socket); else S.notPerson.delete(socket);
  // What it holds now: events only say what changes from here.
  if (!client.supports('checkpoint.list')) return;
  void client.request('checkpoint.list', {}).then(({ checkpoints }) => {
    for (const cp of checkpoints) onCheckpoint(socket, cp);
  }).catch(() => {});
}

function onDaemonLost(socket: string): void {
  // The daemon went away (stopped, or replaced by an update that finished).
  // Its tabs reconnect when shown; if it is gone for good they close then.
  S.cps.dropDaemon(socket);
  store.drop(socket);
  if (term.attached && S.tabs.some((t) => t.kind === 'shell' && t.socket === socket)) { shownKey = ''; void renderCentre(); }
}

function onCommand(name: string, arg?: unknown): void {
  switch (name) {
    case 'new-shell': void newShell(); break;
    case 'new-session': openStart(); break;
    case 'close-tab': { const t = tabOfView(); if (t) void closeTab(t.id); break; }
    case 'next-tab': stepTab(Number(arg) || 1); break;
    // The app's own words for the person (an update that stopped trying): kept until OK.
    case 'update-stopped': showToast(String(arg || ''), [{ label: 'Try again', run: () => api().retryUpdate() }], { key: 'update-stopped', ms: Infinity }); break;
    case 'tab': { const t = S.tabs[Number(arg)]; if (t) setView({ kind: 'tab', id: t.id }); break; }
    case 'toggle-panel': togglePanel(); break;
  }
}

/** The open card the panel shows, for the number keys. */
function shownCard(): Known | null {
  if (!panelVisible()) return null;
  const el = document.querySelector('#panel .cp[data-cp]') as HTMLElement | null;
  const k = el ? S.cps.get(el.dataset.cp!) : null;
  return k && k.cp.state === 'open' ? k : null;
}

// ---------------------------------------------------------------- render

function render(): void {
  dropFrontToast();
  document.body.classList.toggle('mac', isMac());
  document.body.classList.toggle('first', firstRun());
  renderSidebar();
  renderTabs();
  renderPanel();
  void renderCentre().then(() => { renderStrip(); film?.follow(paneOnScreen()); });
}

/** The plain shells: every running daemon's panes labelled as the app's shells. */
async function restoreTabs(saved: Record<string, unknown>): Promise<void> {
  const sockets = await api().daemonSockets().catch(() => [] as string[]);
  // Once: the shells an older version kept in window.json get the label.
  const old = !saved.shellsLabelled && Array.isArray(saved.tabs) ? saved.tabs as { kind?: string; socket?: string; pane?: string; agent?: string | null; key?: string }[] : null;
  const shells: ShellTab[] = [];
  await Promise.all(sockets.map(async (socket) => {
    try {
      const c = await daemons.get(socket);
      if (old) {
        for (const t of old) {
          if (t && t.kind === 'shell' && t.socket === socket && t.pane) {
            await c.request('pane.update', { pane: t.pane, labels: { ...SHELL_LABEL, ...(t.agent ? { 'ravenry.agent': t.agent } : {}) } }).catch(() => {});
          }
        }
      }
      const { panes } = await c.request('pane.list', { hidden: true, labels: { ...SHELL_LABEL } });
      for (const p of panes) {
        if (p.state !== 'running') continue;
        const t: ShellTab = { id: shellId(p.id), kind: 'shell', socket, pane: p.id, agent: p.labels?.['ravenry.agent'] || null };
        applyPane(t, p);
        shells.push(t);
      }
      // The agents' own panes: back as tabs too (their places from the saved order).
      const all = await c.request('pane.list', {}).catch(() => ({ panes: [] as Pane[] }));
      for (const p of all.panes) {
        if (!agentPane(p) || shells.some((x) => x.pane === p.id)) continue;
        const t: ShellTab = { id: shellId(p.id), kind: 'shell', socket, pane: p.id, owner: p.creator!.pane! };
        applyPane(t, p);
        shells.push(t);
      }
    } catch { /* that daemon is gone, and its panes with it */ }
  }));
  shells.sort((a, b) => (a.createdAt || '') < (b.createdAt || '') ? -1 : 1);
  const pinned = (Array.isArray(saved.pinned) ? saved.pinned as string[] : old ? old.filter((t) => t && t.kind === 'session' && t.key).map((t) => t.key!) : [])
    .map((key): SessionTab => ({ id: pinId(key), kind: 'session', key }));
  const tabs: Tab[] = [...shells, ...pinned];
  // The order the person left them in, where it still holds.
  const order = Array.isArray(saved.order) ? saved.order as string[] : old ? old.map((t) => (t.kind === 'shell' ? shellId(t.pane || '') : pinId(t.key || ''))) : [];
  const rank = (t: Tab) => { const i = order.indexOf(t.id); return i < 0 ? order.length + tabs.indexOf(t) : i; };
  S.tabs = tabs.sort((a, b) => rank(a) - rank(b));
  const activeId = typeof saved.active === 'string' ? saved.active : null;
  const active = activeId ? S.tabs.find((t) => t.id === activeId) : null;
  S.view = active ? { kind: 'tab', id: active.id } : S.tabs[0] ? { kind: 'tab', id: S.tabs[0].id } : { kind: 'none' };
  S.restored = true;
  if (old) save();
}

async function boot(): Promise<void> {
  S.config = await api().config();
  document.body.classList.toggle('mac', isMac());
  term = new TerminalView($('term'));
  term.isAppKey = (e) => {
    // The app's shortcuts reach the menu instead of the shell.
    if (isMac()) return e.metaKey;
    return e.ctrlKey && e.shiftKey && /^[tTwWnNbBcCvVaA]$/.test(e.key);
  };
  // The Cmd keys of macOS's terminals xterm.js does not do (terminal.ts).
  term.mac = isMac();
  term.onKeyAct = (act) => {
    const t = term.term;
    if (act === 'clear') {
      // In the daemon (pane.clear), so the history does not come back with
      // the next snapshot; a daemon too old for it: the window's own clear.
      const a0 = term.attached;
      if (a0 && a0.client.supports('pane.clear')) void a0.client.request('pane.clear', { pane: a0.pane }).catch(() => t.clear());
      else t.clear();
      return;
    }
    if (act === 'select-all') { t.selectAll(); return; }
    if (act === 'copy') { if (t.hasSelection()) api().copyText(t.getSelection()); return; }
    const a = term.attached;
    if (a) void api().readClipboard().then((text) => { if (text) void a.client.paste(a.pane, text).catch(() => {}); });
  };
  term.onEnded = (a) => {
    const t = S.tabs.find((x): x is ShellTab => x.kind === 'shell' && x.pane === a.pane);
    if (t) { removeTab(t.id); void a.client.request('pane.close', { pane: a.pane }).catch(() => {}); }
  };
  daemons = new Daemons(onDaemonEvent, onDaemonLost, onDaemonReady);
  store.useClients((s) => daemons.get(s));
  marks = new TerminalMarks(term.term, {
    who: (r) => (r.source.kind === 'person' ? null : (() => { const w = sourceOf(r.source); return { name: w.who, cls: w.cls }; })()),
    note: (r) => { const a = term.attached; const l = a ? letBy(a.pane, r) : null; return l ? (l.once ? 'you let it once' : 'you let it for its session') : null; },
    time: (iso) => timeOf(iso, now()),
  });
  term.onShown = (a) => { marks.reset(); if (a) marks.show(store.inputsOf(a.pane)); renderStrip(); };
  term.onWritten = (_a, mark, snapshot) => marks.written(mark, snapshot);
  (window as unknown as { __ravenryHome?: string }).__ravenryHome = S.config.home;
  machinesView = new Machines($('machines'), {
    call: (method, p, body) => api().hubCall(method, p, body),
    toast: (text) => toast(text),
    copy: (text) => api().copyText(text),
  });
  pages = new Pages($('page'), {
    hubUrl: () => S.config?.hubUrl || '',
    call: (method, p, body) => api().hubCall(method, p, body),
    toast: (text, undo, at) => toast(text, undo, at ? { at: viewKey({ kind: 'page', key: at.page }), error: at.error } : undefined),
    pickSession: (key) => pickSession(key),
    openPage: (key) => openPage(key),
    pickProject: (id) => {
      const p = (S.hub?.projects || []).find((x) => x.id === id || x.name.toLowerCase() === String(id).toLowerCase());
      if (!p || !p.sessions.length) return false;
      pickProject(p);
      return true;
    },
    lastProject: () => lastSessionProject || (viewSessionKey() || '').split('/')[0] || null,
    openBoard,
    openPath: (p) => api().openPath(p),
    openExternal: (url) => api().openExternal(url),
    copy: (text) => api().copyText(text),
    showCheckpoint: (cp) => { S.cps.update(cp as HubCheckpoint); S.panelKey = `cp:${cp.id}`; S.overlay = true; render(); },
    rerender: () => render(),
    now,
  });
  film = new Filmstrip($('fsheet'), $('showing'), $('stage'), {
    now,
    // The terminal's own colours and size: a frame looks as the pane does live.
    theme: () => ({
      fontSize: term.term.options.fontSize || 13,
      scale: window.devicePixelRatio || 1,
      theme: {
        foreground: THEME.foreground, background: THEME.background, cursor: THEME.cursor,
        palette: [THEME.black, THEME.red, THEME.green, THEME.yellow, THEME.blue, THEME.magenta, THEME.cyan, THEME.white, THEME.brightBlack, THEME.brightRed, THEME.brightGreen, THEME.brightYellow, THEME.brightBlue, THEME.brightMagenta, THEME.brightCyan, THEME.brightWhite],
      },
    }),
    // The live text's cell width, for a frame shown at the same size.
    cellWidth: () => {
      const el = document.querySelector('#term .xterm-screen') as HTMLElement | null;
      return el && term.term.cols ? el.getBoundingClientRect().width / term.term.cols : null;
    },
    client: (pane) => daemons.holding(pane),
    sendTo: (pane) => {
      const c = store.get(pane)?.pane.creator;
      const f = c && c.kind === 'agent' && c.pane ? sessionOfPane(S.hub, c.pane) : sessionOfPane(S.hub, pane);
      if (!f) return null;
      return {
        who: assistantName(f.session.assistant) || 'the agent',
        send: async (lastMs) => {
          const r = await api().hubCall('POST', `/api/sessions/${encodeURIComponent(f.session.surfaceId)}/filmstrip`, { pane, last_ms: lastMs });
          if (r.status !== 200) throw new Error((r.body as { error?: string }).error || `the board answered ${r.status}`);
        },
      };
    },
    save: (name, b64) => { const a = h('a', { href: `data:image/gif;base64,${b64}`, download: name }) as HTMLAnchorElement; document.body.append(a); a.click(); a.remove(); },
    paneName: paneNameOf,
    toast: (text) => toast(text),
    changed: () => renderTabs(),
  });
  decisions = new Decisions($('decisions'), {
    call: (method, p, body) => api().hubCall(method, p, body),
    hub: () => S.hub,
    now,
    say: (text, links) => toastLinks(text, links),
    show: () => setView({ kind: 'decisions' }),
    rerender: () => { renderSidebar(); if (panelVisible() && document.querySelector('#panel .cp')) renderPanel(); },
    onScreen: () => S.view.kind === 'decisions',
  });
  picker = new Picker($('picker'), {
    now,
    src: (k, n) => variantSrc(k, n),
    where: (k) => { const t = targetOf(k); const f = findSession(S.hub, t); return f ? [f.session.topic, f.project.name].filter(Boolean).join(', ') : (k.cp as HubCheckpoint).project || null; },
    answer: (k, reply) => answerCp(k, reply),
    close: () => { const v = S.view; setView(v.kind === 'picker' ? v.back : { kind: 'none' }); },
    canAnswer,
  });
  files = new Files({ call: (method, p) => api().hubCall(method, p), now, rerender: () => { if (panelVisible()) renderPanel(); if (S.view.kind === 'grid') void renderCentre(); }, openGrid: (id) => setView({ kind: 'grid', project: id, back: S.view.kind === 'grid' ? S.view.back : S.view }) });
  review = new Review($('review'), {
    call: (method, p, body) => api().hubCall(method, p, body),
    now,
    toast: (text) => toast(text),
    rerender: () => { if (S.view.kind === 'review') void renderCentre(); renderTabs(); if (panelVisible()) renderPanel(); },
    back: () => { const v = S.view; if (v.kind === 'review') setView({ kind: 'session', key: v.key }); },
    // A worktree's folder comes as its real path (/private/var on macOS for /var).
    tilde: (p) => tilde(S.config?.home && !S.config.home.startsWith('/private/') ? p.replace(/^\/private(?=\/var\/)/, '') : p),
  });
  decisions.start();
  onCardChange(() => { renderPanel(); });
  api().onCommand((n, a) => onCommand(String(n), a));
  api().onHubState((s) => onHubState(s as HubState));
  api().onHubStatus((st) => { S.hubStatus = st as HubStatus; setBoardLive(!!(st as HubStatus).reachable); if (!(st as HubStatus).reachable) S.hub = S.hub || null; render(); if (firstRun()) void loadStart(); });
  window.addEventListener('resize', () => { if (wide() && S.overlay && !S.panelKey) S.overlay = false; renderPanel(); renderTabs(); });
  // The strip's room changes when the panel shows or hides.
  new ResizeObserver(() => fitTabs($('tabs'))).observe($('tabs'));
  window.addEventListener('keydown', (e) => {
    if (S.view.kind === 'picker' && picker.key(e)) { e.preventDefault(); return; }
    if (e.key === 'Escape' && S.overlay) { S.overlay = false; S.panelKey = null; render(); term.focus(); return; }
    // Number keys answer the question on screen, unless the keyboard is in
    // the terminal or a field.
    const t = e.target as HTMLElement | null;
    if (t && (t.closest('#term') || t.closest('input, textarea, [contenteditable]'))) return;
    const k = shownCard();
    if (k && cardKey(k, e, cardCtx)) e.preventDefault();
  });
  // The cards' "waiting 2 min" moves on.
  window.setInterval(() => {
    S.cps.prune();
    pruneCards(new Set(S.cps.items.keys()));
    if (panelVisible() && document.querySelector('#panel .cp')) renderPanel();
  }, 20000);
  const saved = await api().storeGet();
  S.panelPref = saved.panelPref === 'closed' || saved.panelPref === 'open' ? saved.panelPref : null;
  S.hooks.asked = !!saved.hooksAsked;
  const hs = await api().hubState();
  S.hub = (hs.state as HubState) || null;
  S.hubStatus = hs.status;
  if (S.hub) { S.cps.fromHub(S.hub.checkpoints as HubCheckpoint[] | undefined); pages.update((S.hub as { pages?: NavRow[] }).pages); }
  await restoreTabs(saved);
  // Like any terminal, a launch ends with a working shell in front: the
  // shells that were open come back, else one opens in the last folder used
  // (else the home folder). A failure says why in a toast.
  // A session that was in front last time, with a pane, is in front again;
  // the launch shell opens only when nothing else comes back.
  // The tabs come back as they were, the one in front in front. A session
  // tab whose pane went with its daemon did not come back: it closes, with
  // nothing said, and a shell is in front instead. The launch shell opens
  // only when no tab came back.
  const was = saved.selected as { key?: string; pane?: string } | null | undefined;
  if (was && typeof was.key === 'string' && typeof was.pane === 'string' && !S.tabs.some((t) => t.kind === 'session' && t.key === was.key)) {
    // A window.json from before every session was a tab.
    const t: SessionTab = { id: pinId(was.key), kind: 'session', key: was.key, pane: was.pane };
    S.tabs.push(t);
    S.view = { kind: 'tab', id: t.id };
  }
  const frontId = S.view.kind === 'tab' ? S.view.id : null;
  const gone = await Promise.all(S.tabs.map(async (t) => {
    if (t.kind !== 'session') return null;
    const p = (t.key.match(/\/ravenry:(p[a-z2-7]{7})$/) || [])[1] || t.pane;
    return p && !(await daemons.holding(p).then((c) => !!c, () => false)) ? { t, p } : null;
  }));
  for (const g of gone) if (g) { api().log(`window: launch: ${g.t.key} (pane ${g.p}) is gone; its tab closes`); removeTab(g.t.id); }
  if (frontId && !S.tabs.some((t) => t.id === frontId)) {
    const sh = S.tabs.find((t) => t.kind === 'shell') || S.tabs[0];
    S.view = sh ? { kind: 'tab', id: sh.id } : { kind: 'none' };
  }
  const fr = tabOfView();
  if (fr && fr.kind === 'session') api().log(`window: launch: the session that was in front, ${fr.key}`);
  if (!S.tabs.length) await newShell(typeof saved.lastCwd === 'string' ? saved.lastCwd : null);
  // The daemon new panes go to is followed from the start, for its checkpoints.
  void daemons.forNew().catch(() => {});
  render();
  if (firstRun() || !S.tabs.length) void loadStart();
  // For tests and screenshots (tools/driver.cjs): the state and a few calls.
  (window as unknown as { __ravenry: unknown }).__ravenry = {
    S, term: () => term, newShell, setView, onCommand, pickSession, render, ready: true, pages: () => pages, openPage, machines: () => machinesView,
    store, marks: () => marks, film: () => film, decisions: () => decisions, picker: () => picker, files: () => files, review: () => review, openPicker,
    text: () => { const b = term.term.buffer.active; const out: string[] = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) || ''); return out.join('\n'); },
  };
  initNpmSwitch(() => render());
  document.body.dataset.ready = '1';
}

void boot().catch((e) => {
  document.body.dataset.ready = 'error';
  console.error(e);
  toast(`Ravenry could not start: ${(e as Error).message}`);
});
