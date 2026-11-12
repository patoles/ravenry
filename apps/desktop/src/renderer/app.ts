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
import type { AppConfig, AssistantInfo, FolderPick, HubStatus, StartView } from './api.ts';
import type { SkillRow } from '../shared/skills.ts';
import { cardFor, cardKey, clearHiddenSecrets, focusCard, NotPerson, onCardChange, pruneCards } from './cards.ts';
import type { CardCtx, Reply } from './cards.ts';
import { Checkpoints, daemonAnswer, hubAnswer, isOpen, timeOf, wordsBody } from './checkpoints.ts';
import type { HubCheckpoint, Known } from './checkpoints.ts';
import { Daemons } from './daemons.ts';
import { h, heldIn, preloadPicture, redraw, replace, svg } from './dom.ts';
import * as I from './icons.ts';
import {
  ago, arrivals, assistantName, board, secondLine, clock, findSession, isEmpty, machineOf, memoryLine, paneOf, rekeyed, sessionGroup, sessionKey, sessionOfPane, tokens,
} from './model.ts';
import type { Group, HubProject, HubSession, HubState } from './model.ts';
import { Machines, MACHINES_ICON } from './machines.ts';
import { initNpmSwitch, npmChosen, npmTakesCentre, renderNpmCentre, renderNpmPointer, setBoardLive } from './npmswitch.ts';
import type { MachineView } from './machines.ts';
import { Pages } from './pages.ts';
import { renderLearn } from './learn.ts';
import type { LearnCard, LearnKey } from './learn.ts';
import type { NavRow } from './pages.ts';
import { FONT_SIZE, TerminalView, THEME, watchLongTasks } from './terminal.ts';
import { PaneStore } from './panes.ts';
import { TerminalMarks } from './marks.ts';
import type { SettingsSnapshot, TerminalSettings } from '../shared/settings.ts';
import Split from 'split.js';
type SplitInstance = ReturnType<typeof Split>;
import { briefPage, plain } from './briefdoc.ts';
import type { NextParts } from './briefdoc.ts';
import { leaseStrip, leaseWords, openedLine, panesItUses, typedHere, whoCanType } from './panepanel.ts';
import type { PaneCtx, Who } from './panepanel.ts';
import { Filmstrip } from './filmstrip.ts';
import { Decisions } from './decisions.ts';
import { Picker } from './picker.ts';
import { Files } from './files.ts';
import { Review } from './review.ts';
import { sayPathOn } from '../../../../hub/public/homepath.mjs';
import { PhoneCard } from './phonecard.ts';
import { InApp, IN_KINDS } from './inapp.ts';
import type { InView } from './inapp.ts';
import * as onb from './onboarding.ts';

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
  split?: SplitInfo; host?: string;
}
/** A session's tab; `pane` for one just started, until the hub lists it. */
interface SessionTab { id: string; kind: 'session'; key: string; pane?: string; /** Its name when last on the board. */ name?: string; split?: SplitInfo; host?: string }
/**
 * A tab split in two (the picture ravenry-split.html, B1): the tab hosts a
 * second pane, a shell tab of its own that the strip does not show
 * (`guest`, whose `host` names this tab). At most one split per tab; more
 * panes are tabs. `side`: where the guest is; `size`: the host's share, in
 * percent; `focus`: 1 when the guest has the keyboard; `zoom`: the focused
 * pane alone, for now.
 */
interface SplitInfo { guest: string; side: 'right' | 'left' | 'down' | 'up'; size: number; focus: 0 | 1; zoom?: boolean }
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
  /** A project's brief as a page, beside the session it was opened from (briefdoc.ts). */
  | { kind: 'brief'; key: string; project: string }
  /** A project no session runs in, picked in the sidebar: what it is and a way to start one. */
  | { kind: 'project'; id: string }
  /** Learn Ravenry (learn.ts): opened by the person, never by itself; `lit` is the card Learn more points at. */
  | { kind: 'learn'; lit?: LearnKey | null; back?: View }
  | { kind: 'start' }
  /** Ravenry's own pages for what opened the board before (inapp.ts): a project's pictures, a plan, a new plan, an idea, Alerts. */
  | { kind: 'gallery'; project: string; at?: number | null; lit?: number | null; back: View }
  | { kind: 'plan'; project: string; title?: string | null; back: View }
  | { kind: 'newplan'; project: string; back: View }
  | { kind: 'idea'; id: string; back: View }
  | { kind: 'alerts'; back: View }
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
  /**
   * The first-launch step 2 (A2): the agreement for the assistant picked,
   * its hooks and the Ravenry skill, shown once per assistant after Start.
   */
  setup: null as null | SetupStep,
  /** The assistants whose step 2 was answered (Set them up or Not now). */
  setupAsked: {} as Record<string, boolean>,
};

interface SetupStep {
  kind: 'claude' | 'codex';
  /** Ticked. */
  hooks: boolean; skill: boolean;
  /** Already on (the line says so and is not written again). */
  hooksOn: boolean; skillOn: boolean;
  /** The file the hooks go in, or null when the board cannot write them now. */
  hooksFile: string | null; skillDir: string;
  busy: boolean; error: string | null;
}

const $ = (id: string) => document.getElementById(id)!;
/** The terminal of the pane with the keyboard: termA (the tab's own pane) or termB (its split's). */
let term: TerminalView;
let termA: TerminalView;
let termB: TerminalView | null = null;
let daemons: Daemons;
let pages: Pages;
let machinesView: Machines;
let film: Filmstrip;
let decisions: Decisions;
let inapp: InApp;
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
/** New Session: Cmd+Shift+N (Cmd+N is a new window, as in every Mac terminal). */
const newSessionKey = () => (isMac() ? '⌘⇧N' : 'Ctrl+Shift+Alt+N');
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
let marksA: TerminalMarks;
let marksB: TerminalMarks | null = null;

/** Who a Source is, as people know it: "Claude" in "Tilting the hull", "You". */
// The person's own input: what they typed or pasted in this window
// (`ravenry-desktop`, whatever the daemon judged it: a window started from
// a pane was once taken for that pane's agent) or on the phone's terminal
// (`ravenry-hub-term`). Never marked on the screen (marks.ts).
const PERSON_CLIENTS = new Set(['ravenry-desktop', 'ravenry-hub-term']);
function byPerson(src: Source | null | undefined): boolean {
  return !src || src.kind === 'person' || PERSON_CLIENTS.has(src.client || '');
}

function sourceOf(src: Source | null | undefined): Who {
  if (!src || byPerson(src)) return { who: 'You', where: null, cls: 'you' };
  if (src.kind === 'agent' && src.pane) {
    const f = sessionOfPane(S.hub, src.pane);
    const k = store.get(src.pane);
    const kind = f?.session.assistant || k?.pane.agent?.assistant || k?.pane.labels?.['ravenry.agent'] || null;
    const who = assistantName(kind) || 'An agent';
    const t = S.tabs.find((x): x is ShellTab => x.kind === 'shell' && x.pane === src.pane);
    const where = f ? f.session.topic || f.project.name : t ? tabLabel(t).name : k?.pane.name || null;
    return { who, where: where && where !== who ? where : null, cls: kind === 'claude' || kind === 'codex' ? kind : 'other' };
  }
  // The hub: Move here's resume command, a hand-off's prompt.
  if (src.client === 'ravenry-hub') return { who: 'Ravenry', where: null, cls: 'other' };
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
  if (what.kind === 'input') for (const p of [...pools[0], ...pools[1]]) if (p.view.attached?.pane === what.pane) p.marks.show(store.inputsOf(what.pane));
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
  // ?as=png: an HTML variant comes drawn as a picture (the hub renders it, scripts off); a picture comes as it is.
  return `${S.config.hubUrl}/api/checkpoints/${encodeURIComponent(k.cp.id)}/variants/${n}?as=png`;
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
  const strip = pane && !$('split').hidden ? leaseStrip(pane, paneCtx) : null;
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
  const f = k && !k.startsWith('tab:') && !$('split').hidden ? findSession(S.hub, k) : null;
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

/** A window opened with Cmd+N: its own shells carry its id (ravenry.window); the first window has none. */
const windowId: string | null = null as string | null;
let thisWindow: string | null = windowId;

/** The tabs where a bell rang while they were not on screen. */
const bells = new Set<string>();
const tabBell = (t: Tab) => bells.has(t.id) || (!!t.split && bells.has(t.split.guest));

// ---- splits (SplitInfo)
/** The tabs of the strip: a split's second pane is not one. */
const stripTabs = () => S.tabs.filter((t) => !t.host);
function guestOf(t: Tab | null): ShellTab | null {
  const g = t && t.split ? S.tabs.find((x) => x.id === t.split!.guest) : null;
  return g && g.kind === 'shell' ? g : null;
}
function hostOf(t: Tab): Tab | null { return t.host ? S.tabs.find((x) => x.id === t.host) || null : null; }
/** The pane with the keyboard: the tab in front, or its split's pane. */
function focusedTab(): Tab | null {
  const t = tabOfView();
  const g = guestOf(t);
  return g && t!.split!.focus === 1 ? g : t;
}
function linkSplit(host: Tab, guest: ShellTab, side: SplitInfo['side'], focus: 0 | 1): void {
  if (host.split || host.host || guest.split || guest.host || host.id === guest.id) return;
  host.split = { guest: guest.id, side, size: 50, focus };
  guest.host = host.id;
}
function unlinkSplit(host: Tab): void {
  const g = guestOf(host);
  if (g) delete g.host;
  delete host.split;
}

/** A tab's session: its own, or the one its pane runs. */
function tabSessionKey(t: Tab | null): string | null {
  if (t && t.kind === 'shell') return sessionOfPane(S.hub, t.pane)?.key || null;
  return t && t.kind === 'session' ? t.key : null;
}

/** The session the middle shows: a pinned session's tab, a session picked in the sidebar, or the one the focused pane runs. */
function viewSessionKey(): string | null {
  const v = S.view;
  if (v.kind === 'review' || v.kind === 'brief') return v.key;
  if (v.kind === 'session') return v.key || (v.pane ? sessionOfPane(S.hub, v.pane)?.key || null : null);
  return tabSessionKey(focusedTab());
}

/** The views that take the middle and right columns. */
const WIDE_VIEWS = new Set(['page', 'machines', 'decisions', 'picker', 'grid', 'learn', ...IN_KINDS]);

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
  if (S.view.kind === 'session' || S.view.kind === 'pane' || S.view.kind === 'review' || S.view.kind === 'brief' || S.view.kind === 'project' || WIDE_VIEWS.has(S.view.kind)) return false;
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
    // Only a session's key is pinned (a tab of a session the board does not list yet has none).
    pinned: S.tabs.filter((x): x is SessionTab => x.kind === 'session' && typeof x.key === 'string' && !!x.key).map((x) => x.key),
    order: S.tabs.map((x) => x.id),
    // Each split, by its tab: back after a relaunch or an update when both panes are.
    splits: S.tabs.filter((x) => x.split && guestOf(x)).map((x) => ({ host: x.id, ...x.split! })),
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
  // Not on the board yet (just started), or off it for now: the name it
  // had, else "Session" with its folder, as other tabs say theirs.
  if (!f) { const cwd = t.pane ? store.get(t.pane)?.pane.cwd : null; return { name: t.name || 'Session', sub: !t.name && cwd ? base(cwd) : null, group: 'idle', machine: null }; }
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
  markUsed('needs');
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
        // Older only when it does not know the field (unknown field "command"); else it refused what was written, in its own words.
        if (code === 'bad_request' && ('command' in reply || 'reason' in reply) && /unknown field/.test((e as Error).message)) throw new Error(`This ravenryd did not take the answer, so nothing ran: ${(e as Error).message}. An older ravenryd cannot run an edited command or pass a reason on; update it, or answer without them.`);
        if (code === 'bad_request' && ('command' in reply || 'reason' in reply)) throw new Error(`ravenryd did not take the answer, so nothing ran: ${(e as Error).message}`);
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
  if (S.view.kind === 'project') return `project:${S.view.id}`;
  const key = viewSessionKey();
  if (key) return key;
  const t = focusedTab();
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
  const groups = board(S.hub, now());
  const counts: Record<Group, number> = { you: 0, work: 0, wait: 0, idle: 0 };
  for (const g of groups) counts[g.group] = g.count;
  const total = counts.you + counts.work + counts.wait + counts.idle;

  const brand = h('div.brand', svg(I.LOGO), 'Ravenry', h('span.sp'),
    // On while Start is in front: it is where the button leads.
    h(`button.icon-btn.sm${S.view.kind === 'start' ? '.on' : ''}`, { title: `New session (${newSessionKey()})`, 'aria-label': 'New session', 'data-prep': '{"kind":"start"}', 'aria-pressed': S.view.kind === 'start' ? 'true' : 'false', on: { click: () => openStart() } }, svg(I.PLUS())));

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
        // Every row opens what it stands for on the first press: an idle
        // project, and a project shown with no session row (Waiting on
        // others from its brief, a plan gate), open its main session, else
        // the project itself (2026-11-08: "only "needs you" sessions are
        // clickable, all other (waiting, idle, ..) are not").
        const pk = `project:${pr.project.id}`;
        const fk = frontKey();
        const psel = fk === pk || (!!fk && fk.startsWith(`${pr.project.id}/`) && !pr.rows.some((r) => r.key === fk));
        // An idle project is one line; an idle session of a project at work is a row under it.
        if (g.group === 'idle' && !pr.rows.length) {
          return h(`button.idl${psel ? '.sel' : ''}`, { 'data-key': pk, on: rowPress(() => pickProject((S.hub?.projects || []).find((x) => x.id === pr.project.id) || pr.project)) },
            h('span.n', pr.project.name), machineTag(pr.machine), h('span.t3.num.when', pr.time));
        }
        if (!pr.rows.length) {
          return h(`div.pj.open${psel ? '.sel' : ''}`, { role: 'button', tabindex: '0', 'data-key': pk, on: rowPress(() => pickProject((S.hub?.projects || []).find((x) => x.id === pr.project.id) || pr.project)) },
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
            return h(`div.ss${sel ? '.sel' : ''}`, { role: 'button', tabindex: '0', 'data-key': r.key, on: rowPress(() => pickSession(r.key)) },
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
    h('button.icon-btn', { title: 'Settings', 'aria-label': 'Settings', on: { click: () => api().settings.open() } }, svg(I.SETTINGS)),
    empty ? null : h(`button.icon-btn${phoneCard.open ? '.on' : ''}`, { title: 'Open on your phone', 'aria-label': 'Open on your phone', 'aria-haspopup': 'dialog', on: { click: (e: Event) => { if (npmPoint('Pairing a phone')) return; if (!phoneCard.open) markUsed('phone'); phoneCard.toggle(e.currentTarget as HTMLElement); } } }, svg(I.PHONE)),
    empty ? null : h(`button.icon-btn${counts.you ? '.alert' : ''}${S.view.kind === 'alerts' ? '.on' : ''}`, { title: 'Alerts', 'aria-label': 'Alerts', 'data-prep': '{"kind":"alerts","back":{"kind":"none"}}', 'aria-pressed': S.view.kind === 'alerts' ? 'true' : 'false', on: { click: () => { if (npmPoint('Alerts')) return; if (S.view.kind !== 'alerts') setView({ kind: 'alerts', back: S.view }); } } }, svg(I.BELL)),
    h(`button.icon-btn.learn-btn${S.view.kind === 'learn' ? '.on' : ''}`, { title: 'Learn Ravenry', 'aria-label': 'Learn Ravenry', on: { click: () => openLearn() } }, svg(I.QUESTION)),
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
  // Drawn again only when it changed, and its list keeps where it was
  // scrolled (it was set back to the top at each state from the board).
  redraw($('side'), h('div.side-top'), brand, mix, deniedNote, list, empty ? h('span.fill') : null, nav, foot);
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

/** Where a Ravenry page goes back to: the view it was opened from, never another of its own. */
const backFrom = (): View => (IN_KINDS.has(S.view.kind) ? (S.view as { back: View }).back : S.view);

function openPage(key: string): void {
  if (npmPoint('That page')) return;
  S.overlay = false;
  S.panelKey = null;
  setView({ kind: 'page', key });
}

// ---------------------------------------------------------------- learn (E) and hints (F)

/** The parts of Ravenry the person used (Learn Ravenry ticks them). */
let learnUsed: Partial<Record<LearnKey, boolean>> = {};
function markUsed(k: LearnKey): void {
  if (learnUsed[k]) return;
  onbMark('learn', k);
}

// The onboarding marks (Learn ticks, hints dismissed, step 2 answered) are
// the hub's (onboarding.ts, GET and POST /api/onboarding); the store keeps
// only those the board does not have yet.
let onbLocal: onb.Onboarding = { hints: {}, learn: {}, setup: {} };
const onbNow = (): onb.Onboarding => ({ hints: hintsDone as onb.Marks, learn: learnUsed as onb.Marks, setup: S.setupAsked });
function onbTake(o: onb.Onboarding): void { hintsDone = o.hints; learnUsed = o.learn; S.setupAsked = o.setup; }
/** A mark: to the board, else kept in the store until the board answers. */
function onbMark(g: onb.Group, id: string): void {
  const one = { [g]: { [id]: true } };
  onbTake(onb.union(onbNow(), one));
  const keep = () => { onbLocal = onb.union(onbLocal, one); api().storeSet({ [onb.STORE_KEY[g]]: onbLocal[g] }); };
  if (!S.hubStatus?.reachable) { keep(); return; }
  api().hubPost('/api/onboarding', one).catch(keep);
}
/** The board's marks, and the ones only this app had sent to it once (then gone from the store). */
async function onbSync(): Promise<void> {
  if (!S.hubStatus?.reachable) return;
  const sent = onbLocal;
  try {
    let board = await api().hubGet('/api/onboarding') as Partial<onb.Onboarding>;
    const add = onb.missing(sent, board);
    if (add) {
      board = await api().hubPost('/api/onboarding', add) as Partial<onb.Onboarding>;
      api().log(`window: onboarding: sent the board ${onb.GROUPS.map((g) => Object.keys(add[g] || {}).length).join('/')} hints/learn/setup it did not have`);
    }
    onbTake(onb.union(onbNow(), board));
    if (onbLocal === sent && onb.GROUPS.some((g) => Object.keys(sent[g]).length)) { onbLocal = { hints: {}, learn: {}, setup: {} }; api().storeSet(onb.cleared()); }
  } catch { /* kept in the store; sent when the board answers again */ }
}

function openLearn(lit: LearnKey | null = null): void {
  const back = S.view.kind === 'learn' ? S.view.back : S.view;
  S.overlay = false; S.panelKey = null;
  setView({ kind: 'learn', lit, back });
  api().log(`window: Learn Ravenry opened${lit ? ` at ${lit}` : ''}`);
}

const learnHost = {
  used: () => learnUsed,
  close: () => { const v = S.view; setView(v.kind === 'learn' && v.back && v.back.kind !== 'learn' ? v.back : S.tabs[0] ? { kind: 'tab', id: S.tabs[0].id } : { kind: 'none' }); },
  tryIt: (c: LearnCard) => void tryIt(c),
};

/** Try it: the action of a Learn Ravenry card. */
async function tryIt(c: LearnCard): Promise<void> {
  api().log(`window: Learn Ravenry, try ${c.key}`);
  if (c.key === 'phone') {
    learnHost.close();
    requestAnimationFrame(() => { const b = document.querySelector('#side .foot [aria-label="Open on your phone"]') as HTMLElement | null; if (b && !phoneCard.open) b.click(); });
    return;
  }
  if (c.key === 'film') {
    // The busiest terminal: the shell tab that printed last.
    const tabs = S.tabs.filter((t): t is ShellTab => t.kind === 'shell');
    if (!tabs.length) { toast('The filmstrip needs a terminal with some history: open one and use it a little first.'); return; }
    let best = tabs[0], most = '';
    for (const t of tabs) { const at = store.get(t.pane)?.pane.last_output_at || ''; if (at > most) { most = at; best = t; } }
    setView({ kind: 'tab', id: best.id });
    setTimeout(() => { const pn = paneOnScreen(); if (pn && !film.open) { markUsed('film'); void film.toggle(pn); } }, 400);
    return;
  }
  // A session in the last folder used, with the message in its input, not sent.
  if (!S.hubStatus?.reachable) { toast('Try it starts a session through Ravenry\u2019s board, which is not running.'); return; }
  const lastProject = lastSessionProject ? (S.hub?.projects || []).find((p) => p.id === lastSessionProject) : null;
  const saved = await api().storeGet().catch(() => ({} as Record<string, unknown>));
  const folder = (lastProject && !lastProject.machine && lastProject.folder) || (typeof saved.lastCwd === 'string' ? saved.lastCwd : null) || S.config?.home || null;
  const found = await startView().then((v) => v.assistants, () => [] as AssistantInfo[]);
  const a = found.find((x) => x.kind === S.start.assistant && x.found) || found.find((x) => x.kind === 'claude' && x.found) || found.find((x) => x.found);
  if (!a) { toast('Try it needs Claude Code or Codex on this Mac.'); return; }
  const proj = folder ? (S.hub?.projects || []).find((p) => p.folder === folder && !p.machine) : null;
  try {
    const r = await api().hubPost('/api/sessions/start', { folder, assistant: a.kind, cols: term.term.cols, rows: term.term.rows, ...(c.worktree && proj ? { worktree: true, projectId: proj.id } : {}) }) as { surfaceId?: string; pane?: { id?: string }; projectId?: string | null };
    const pane = r.pane && typeof r.pane.id === 'string' ? r.pane.id : null;
    setView({ kind: 'session', key: r.projectId && r.surfaceId ? `${r.projectId}/${r.surfaceId}` : '', ...(pane ? { pane } : {}) });
    if (pane && c.message) void readyMessage(pane, c.message);
  } catch (e) { toast(`Could not start it: ${(e as Error).message}`); }
}

/**
 * Puts `text` in the assistant's input once it is waiting there: its screen
 * drawn and still for 1.5 s. No Enter: the person reads it and sends it.
 */
async function readyMessage(pane: string, text: string): Promise<void> {
  const t0 = Date.now();
  let last = '', since = Date.now();
  while (Date.now() - t0 < 40000) {
    const at = term.attached;
    const now = at && at.pane === pane && term.ready ? viewText().trim() : '';
    if (now !== last) { last = now; since = Date.now(); }
    else if (now && Date.now() - since >= 1500 && at) {
      try { await at.client.paste(pane, text); api().log(`window: Try it, a message ready in ${pane}`); return; } catch { break; }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  api().copyText(text);
  toast('The message is on the clipboard: paste it when the assistant is ready.');
}

/** What the terminal with the keyboard shows, as text. */
function viewText(): string {
  const b = term.term.buffer.active;
  const out: string[] = [];
  for (let y = 0; y < b.length; y++) out.push(b.getLine(y)?.translateToString(true) || '');
  return out.join('\n');
}

// One-time hints (F): a line under the thing itself, the first time it
// happens, with Learn more and an x. Dismissed (either), never again.
type HintId = 'agent-pane' | 'needs-you' | 'pick';
const HINT_CARD: Record<HintId, LearnKey> = { 'agent-pane': 'panes', 'needs-you': 'needs', pick: 'pick' };
let hintsDone: Partial<Record<HintId, boolean>> = {};
let hintNow: { id: HintId; tab?: string } | null = null;

function wantHint(id: HintId, tab?: string): void {
  if (hintsDone[id] || (hintNow && hintNow.id !== id)) return;
  hintNow = { id, tab };
}
function dismissHint(learn: boolean): void {
  if (!hintNow) return;
  const id = hintNow.id;
  onbMark('hints', id);
  api().log(`window: hint ${id} dismissed${learn ? ' (Learn more)' : ''}`);
  hintNow = null;
  renderHint();
  if (learn) openLearn(HINT_CARD[id]);
}

/**
 * The hint's place and words now, or null while its thing is not on screen.
 * `region`: where it may sit, the part of the window it points into (the
 * middle column for a pane's tab and a sidebar row, the picker's page):
 * never over the panel, the sidebar or the tab strip.
 */
function hintAt(): { el: Element; region: DOMRect; html: (HTMLElement | string)[]; beside?: boolean; room?: boolean } | null {
  const hn = hintNow;
  if (!hn) return null;
  if (hn.id === 'agent-pane') {
    const t = S.tabs.find((x): x is ShellTab => x.kind === 'shell' && x.id === hn.tab);
    if (!t) { hintNow = null; return null; }
    const host = S.tabs.find((x) => x.split && x.split.guest === t.id);
    const el = document.querySelector(`#tabs .tab[data-tab="${t.id}"]`) || (host && tabOfView()?.id === host.id ? $('phead1') : null);
    if (!el || (el as HTMLElement).offsetParent === null) return null;
    const owner = t.owner ? sessionOfPane(S.hub, t.owner) : null;
    const who = assistantName(owner?.session.assistant || null) || 'An agent';
    // In a split, its own pane is the region (under that pane's header),
    // unless that pane is too narrow for one: then the middle column.
    const pane = el === $('phead1') ? (() => { const pb = $('pbox1').getBoundingClientRect(); const top = el.getBoundingClientRect().bottom; return new DOMRect(pb.left, top, pb.width, pb.bottom - top); })() : null;
    const region = pane && pane.width >= 320 ? pane : middleRegion();
    return { el, region, html: [h('b', t.name ? `${who} opened \u201c${t.name}\u201d` : `${who} opened this pane`), ' beside it. Watch it here, or type in it yourself.'] };
  }
  if (hn.id === 'needs-you') {
    const el = document.querySelector('#side .g-you .ss');
    return el ? { el, region: middleRegion(), beside: true, html: [h('b', 'This session waits on you.'), ' Answer it here, or on your phone; the ones that need you stay on top.'] } : null;
  }
  // Under the picker's title, in room made for it there (pickRoom): the
  // pictures and the note below it move down, nothing is covered.
  const el = $('picker').querySelector('.pk-h');
  return S.view.kind === 'picker' && el ? { el, region: $('picker').getBoundingClientRect(), room: true, html: [h('b', 'Pick one, or circle the part you mean.'), ' Your answer goes back to the agent.'] } : null;
}

/** The middle column under the tab strip and the bar above the panes: the panes' area (the hints' region there). */
function middleRegion(): DOMRect {
  const c = $('centre').getBoundingClientRect();
  let top = c.top;
  for (const id of ['tabs', 'movebar', 'showing', 'lstrip']) { const e = $(id); if (!e.hidden && e.offsetParent !== null) top = Math.max(top, e.getBoundingClientRect().bottom); }
  return new DOMRect(c.left, top, c.width, c.bottom - top);
}

/** A region less the panel where the panel covers it (open beside, or over the middle). */
function besidePanel(g: DOMRect): DOMRect {
  const p = $('panel');
  if (p.hidden) return g;
  const r = p.getBoundingClientRect();
  if (r.left >= g.right || r.right <= g.left) return g;
  return new DOMRect(g.left, g.top, Math.max(0, r.left - g.left), g.height);
}
let hintRegion: DOMRect | null = null;

function renderHint(): void {
  if (!hintNow && document.querySelector('#side .g-you .ss')) wantHint('needs-you');
  const box = $('hint');
  const at = hintAt();
  // The room made under a picker's title goes with its hint.
  for (const e of document.querySelectorAll<HTMLElement>('[data-hint-room]')) if (!at || e !== at.el) { e.style.marginBottom = ''; delete e.dataset.hintRoom; }
  if (!at) { box.hidden = true; return; }
  const r = at.el.getBoundingClientRect();
  replace(box, h('div.hint-t', ...at.html),
    h('button.lk', { on: { click: () => dismissHint(true) } }, 'Learn more'),
    h('button.x', { title: 'Dismiss', 'aria-label': 'Dismiss', on: { click: () => dismissHint(false) } }, svg(I.CLOSE)));
  box.dataset.hint = hintNow!.id;
  box.hidden = false;
  // Inside its region, 10 px in from each side: as wide as it wants up to
  // the region's width (its text wraps), moved left as needed; below its
  // thing, else above it.
  const g = besidePanel(at.region), pad = 10;
  // No room beside the panel: it waits until there is.
  if (g.width < 220) { box.hidden = true; hintRegion = null; return; }
  hintRegion = g;
  const w = Math.max(160, Math.min(at.beside ? 420 : 560, g.width - 2 * pad));
  box.style.width = `${w}px`;
  box.classList.toggle('beside', !!at.beside);
  let left: number, top: number;
  if (at.beside) {
    // Beside a sidebar row, pointing at it: the rows under it stay clear.
    left = Math.max(g.left + pad, r.right + 10);
    top = r.top;
  } else {
    left = Math.max(g.left + pad, Math.min(r.left, g.right - pad - w));
    top = r.bottom + 8;
  }
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  const hh = box.getBoundingClientRect().height;
  const flip = !at.beside && top + hh > g.bottom - pad && r.top - 8 - hh >= g.top + pad;
  if (flip) { top = r.top - 8 - hh; box.style.top = `${top}px`; }
  box.style.top = `${Math.max(g.top + pad, Math.min(top, g.bottom - pad - hh))}px`;
  box.classList.toggle('above', flip);
  if (at.room) {
    // Room under its thing, so it covers nothing: what follows moves down.
    const el = at.el as HTMLElement;
    el.dataset.hintRoom = '1';
    el.style.marginBottom = `${hh + 16}px`;
    box.style.top = `${r.bottom + 8}px`;
    box.classList.remove('above');
  }
  if (!at.beside) box.style.setProperty('--arrow', `${Math.max(14, Math.min(w - 20, r.left + Math.min(r.width, 60) / 2 - left))}px`);
}

/**
 * A sidebar row's handlers. It opens on pointerdown, not click: the sidebar
 * is drawn again at each state from the hub (about once a second), and a
 * click whose press and release land on two drawings never fires. A click
 * with no press before it (assistive tools) and Enter open it too. A press
 * on the row's pin button is the pin's.
 */
function rowPress(open: () => void): Record<string, (e: Event) => void> {
  const onPin = (e: Event) => !!(e.target as HTMLElement).closest('button.pin');
  return {
    pointerdown: (e: Event) => { if ((e as PointerEvent).button === 0 && !onPin(e)) { rowPressedAt = Date.now(); open(); } },
    click: (e: Event) => { if (Date.now() - rowPressedAt > 1500 && !onPin(e)) open(); },
    keydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') open(); },
  };
}

/** A project's row: its main session (pickSession), else the project itself, in front. */
function pickProject(p: HubProject, why = 'click'): void {
  const s = p.sessions.find((x) => x.surfaceId === p.primary && !x.handed) || p.sessions.find((x) => !x.handed);
  if (s) { pickSession(`${p.id}/${s.surfaceId}`, why); return; }
  api().log(`window: project ${why} ${p.id}: no session runs in it, the project in front`);
  S.panelKey = null;
  setView({ kind: 'project', id: p.id });
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
  if (v.kind === 'review' || v.kind === 'brief') {
    // The session's own tab, beside its Review or Brief tab (when it has no tab).
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

/** The strip's filmstrip button hangs on the pane the centre shows: whether the strip drawn last has it. */
let tabsFilmable = false;
const filmableNow = (): boolean => !!paneOnScreen() && !$('split').hidden;

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
  // The brief, as a page, while it is open: beside its session, closed back to it.
  const bv = S.view.kind === 'brief' ? S.view : null;
  const bp = bv ? (S.hub?.projects || []).find((x) => x.id === bv.project) : null;
  const bt = bv ? h('div.tab.on', { role: 'tab', 'aria-selected': 'true', 'data-key': `brief:${bv.project}`, title: 'The brief' },
    h('span.ti', svg(I.DOC)), h('span.n', 'Brief'), h('span.p', bp ? bp.name : bv.project),
    h('button.x', { title: 'Close the brief', 'aria-label': 'Close', on: { click: (e: Event) => { e.stopPropagation(); setView(bv.key.startsWith('project:') ? { kind: 'project', id: bv.key.slice(8) } : { kind: 'session', key: bv.key }); } } }, svg(I.CLOSE))) : null;
  // A project no session runs in, while it is in front.
  const pv = S.view.kind === 'project' ? S.view : null;
  const pp = pv ? (S.hub?.projects || []).find((x) => x.id === pv.id) : null;
  const pt = pv ? h('div.tab.on', { role: 'tab', 'aria-selected': 'true', 'data-key': `project:${pv.id}`, title: pp ? pp.name : pv.id },
    h('span.sd', { style: { background: GROUP_VAR[pp && ['you', 'work', 'wait', 'idle'].includes(pp.state) ? pp.state as Group : 'idle'] } }),
    h('span.n', pp ? pp.name : pv.id)) : null;
  const extra = [rv, bt, pt].filter((x): x is HTMLElement => !!x);
  const sessTab = (t: Tab) => (t.kind === 'session' && t.key === rk) || (t.kind === 'shell' && !!rk && sessionOfPane(S.hub, t.pane)?.key === rk);
  const filmable = tabsFilmable = filmableNow();
  const row = h('div.tabrow', { role: 'presentation' },
    openTab(),
    extra.length && !stripTabs().some(sessTab) ? extra : null,
    stripTabs().map((t, i) => {
      const l = tabLabel(t);
      const on = active && active.id === t.id;
      if (on && t.kind === 'shell') t.activity = false;
      const tk = t.kind === 'session' ? t.key : sessionOfPane(S.hub, t.pane)?.key || `tab:${t.id}`;
      return h(`div.tab${on ? '.on' : ''}`, { role: 'tab', 'aria-selected': on ? 'true' : 'false', 'data-key': tk, 'data-tab': t.id, draggable: 'true', title: i < 9 ? `${l.name} (${isMac() ? '⌘' : 'Alt+'}${i + 1})` : l.name, on: { click: () => setView({ kind: 'tab', id: t.id }), auxclick: (e: Event) => { if ((e as MouseEvent).button === 1) closeTab(t.id); }, dragstart: (e: Event) => tabDragStart(e as DragEvent, t), dragend: () => tabDragEnd(), dragover: (e: Event) => tabDragOver(e as DragEvent, t), drop: (e: Event) => tabDrop(e as DragEvent, t) } },
        t.kind === 'shell' && !l.group ? h('span.ti', svg(I.SHELL)) : h('span.sd', { style: { background: GROUP_VAR[l.group || 'idle'] } }),
        h('span.n', l.name),
        l.sub ? h('span.p', l.sub) : null,
        machineTag(l.machine),
        t.kind === 'shell' ? leaseBadge(t.pane) : null,
        t.kind === 'shell' && t.activity && !on ? h('span.act', { title: 'New output' }) : null,
        // A bell in a tab not on screen: until it is opened (F4).
        tabBell(t) && !on ? h('span.tbell', { title: 'A bell rang here' }, svg(I.BELL_S)) : null,
        // A split tab: its pane count.
        t.split && guestOf(t) ? h('span.pc2', { title: 'Two panes, split' }, svg(I.SPLIT), '2') : null,
        h('button.x', { title: t.kind === 'shell' ? `Close (${shortcut('W')})` : 'Close the tab (the session goes on)', 'aria-label': 'Close', on: { click: (e: Event) => { e.stopPropagation(); void askClose(t); } } }, svg(I.CLOSE)));
    }).flatMap((tab, i) => (extra.length && sessTab(stripTabs()[i]) ? [tab, ...extra] : [tab])));
  replace(el,
    row,
    h('button.tab.add', { title: `New shell (${shortcut('T')})`, 'aria-label': 'New shell', on: { click: () => void newShell() } }, svg(I.PLUS(12))),
    h('span.sp'),
    filmable ? h(`button.icon-btn${film.open ? '.on' : ''}`, { title: 'The last 20 seconds of this pane', 'aria-label': 'Filmstrip', on: { click: () => { const pn = paneOnScreen(); if (pn) { if (!film.open) markUsed('film'); void film.toggle(pn); } } } }, svg(I.FILM)) : null,
    // Where no panel can show (Start, the first run, the npm board), no button for it.
    npmTakesCentre() || firstRun() || S.view.kind === 'start' ? null
      : h(`button.icon-btn${panelVisible() ? '.on' : ''}`, { title: panelVisible() ? 'Hide the session panel' : 'Show the session panel', 'aria-label': 'Session panel', on: { click: () => togglePanel() } }, svg(I.PANEL)));
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
    const { pane } = await client.request('pane.new', { cols, rows, name: 'Shell', labels: { ...SHELL_LABEL, ...(thisWindow ? { 'ravenry.window': thisWindow } : {}) }, ...(cmd ? { command: cmd } : {}), ...(cwd ? { cwd } : {}), ...(termSettings ? { scrollback: termSettings.xterm.scrollback } : {}) });
    addShellTab(socket, pane, null, true);
  } catch (e) {
    toast(`Could not open a shell: ${(e as Error).message}`, undefined, { at, error: true });
  }
}

/** Cmd+D, Cmd+Shift+D: a new shell split beside (or under) the pane in front, with the keyboard; a tab when the tab is split already. */
async function splitNew(side: 'right' | 'down'): Promise<void> {
  const host = tabOfView();
  if (!host || host.split || $('split').hidden) { void newShell(); return; }
  const at = here();
  try {
    const { client, socket } = await daemons.forNew();
    const cwd = host.kind === 'shell' && host.cwd ? host.cwd : undefined;
    const cmd = S.config?.newShell;
    const { pane } = await client.request('pane.new', { cols: Math.max(20, Math.floor(termA.term.cols / 2)), rows: termA.term.rows, name: 'Shell', labels: { ...SHELL_LABEL, ...(thisWindow ? { 'ravenry.window': thisWindow } : {}) }, ...(cmd ? { command: cmd } : {}), ...(cwd ? { cwd } : {}), ...(termSettings ? { scrollback: termSettings.xterm.scrollback } : {}) });
    const g = addShellTab(socket, pane, null, false);
    linkSplit(host, g, side, 1);
    save();
    render();
  } catch (e) {
    toast(`Could not open a shell: ${(e as Error).message}`, undefined, { at, error: true });
  }
}

/** An agent's own pane beside its session's (or shell's) tab, without the keyboard, when that tab has no split yet (B1). */
function splitAgentPane(t: ShellTab): void {
  const owner = t.owner;
  if (!owner) return;
  const host = stripTabs().find((x) => x.id !== t.id && ((x.kind === 'shell' && x.pane === owner) || (x.kind === 'session' && (x.pane === owner || x.key.endsWith(`/ravenry:${owner}`) || (() => { const f = findSession(S.hub, x.key); return !!f && paneOf(f.session) === owner; })()))));
  if (host && !host.split) linkSplit(host, t, 'right', 0);
}

// ---- tabs dragged: onto another tab (the strip's order), or onto an edge
// of the pane in front (a split, the four edges lit as the pointer nears).
let dragging: string | null = null;
function tabDragStart(e: DragEvent, t: Tab): void {
  dragging = t.id;
  e.dataTransfer?.setData('application/x-ravenry-tab', t.id);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}
function tabDragEnd(): void { dragging = null; dropZone(null); }
function tabDragOver(e: DragEvent, over: Tab): void {
  if (!dragging || dragging === over.id) return;
  e.preventDefault();
}
function tabDrop(e: DragEvent, over: Tab): void {
  const id = dragging;
  if (!id || id === over.id) return;
  e.preventDefault();
  const t = S.tabs.find((x) => x.id === id);
  if (!t) return;
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const after = e.clientX > r.left + r.width / 2;
  S.tabs.splice(S.tabs.indexOf(t), 1);
  S.tabs.splice(S.tabs.indexOf(over) + (after ? 1 : 0), 0, t);
  dragging = null;
  save();
  renderTabs();
}
/** The edge of the pane in front the pointer is near, or null in the middle. */
function edgeAt(x: number, y: number): SplitInfo['side'] | null {
  const r = $('split').getBoundingClientRect();
  const fx = (x - r.left) / r.width, fy = (y - r.top) / r.height;
  const d = [['left', fx], ['right', 1 - fx], ['up', fy], ['down', 1 - fy]] as const;
  const [side, dist] = [...d].sort((a, b) => a[1] - b[1])[0];
  return dist < 0.3 ? side : null;
}
const EDGE_WORDS: Record<SplitInfo['side'], string> = { left: 'Split left', right: 'Split right', up: 'Split top', down: 'Split bottom' };
function dropZone(side: SplitInfo['side'] | null, why?: string): void {
  const z = $('dropzone');
  z.hidden = !side;
  if (!side) return;
  z.className = `dropzone ${side}${why ? ' no' : ''}`;
  replace(z, h('span.dz-l', why ? null : svg(I.SPLIT), why || EDGE_WORDS[side]));
}
function splitDragOver(e: DragEvent): void {
  if (!dragging) return;
  const host = tabOfView();
  const t = S.tabs.find((x) => x.id === dragging);
  const side = edgeAt(e.clientX, e.clientY);
  if (!host || !t || t.id === host.id) { dropZone(null); return; }
  e.preventDefault();
  if (!side) { dropZone(null); return; }
  dropZone(side, host.split ? 'Already split: one split per tab' : t.kind !== 'shell' ? 'Only a shell or a pane splits' : undefined);
}
function splitDrop(e: DragEvent): void {
  const id = dragging;
  dragging = null;
  dropZone(null);
  const host = tabOfView();
  const t = id ? S.tabs.find((x) => x.id === id) : null;
  const side = edgeAt(e.clientX, e.clientY);
  if (!host || !t || !side || t.id === host.id || host.split || t.kind !== 'shell' || t.split) return;
  e.preventDefault();
  linkSplit(host, t, side, 1);
  save();
  render();
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
  markUsed('panes');
  wantHint('agent-pane', t.id);
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
  // A split's pane goes: its tab is whole again. A split tab goes: its
  // split's pane is a tab of its own, where the tab was, and in front if it was.
  const h0 = hostOf(t);
  if (h0) { unlinkSplit(h0); if (S.view.kind === 'tab' && S.view.id === h0.id) focusSplit(0); }
  const g0 = guestOf(t);
  if (g0) {
    unlinkSplit(t);
    S.tabs.splice(S.tabs.indexOf(g0), 1);
    S.tabs.splice(S.tabs.indexOf(t) + 1, 0, g0);
    if (S.view.kind === 'tab' && S.view.id === id) S.view = { kind: 'tab', id: g0.id };
  }
  S.tabs.splice(S.tabs.indexOf(t), 1);
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
  const tabs = stripTabs();
  if (!tabs.length) return;
  const cur = tabOfView();
  const i = cur ? tabs.indexOf(cur) : -1;
  const n = tabs[(i + d + tabs.length) % tabs.length];
  setView({ kind: 'tab', id: n.id });
}

// ---------------------------------------------------------------- middle

// The strip works like any terminal's (2026-11-07: "if I select on other
// tab at the top the ravenry tab disappears"): a session or a pane comes to
// the front as a tab, which stays until it is closed; clicking a tab only
// brings it to the front. Here, the one place every caller goes through.
function setView(v: View): void {
  // A Review or Brief of no session, or a session with neither a key nor a
  // pane, shows nothing: it changes nothing (it used to add a tab of no
  // session, saved as pinned: [null], which stopped the next launch).
  if (((v.kind === 'review' || v.kind === 'brief') && !v.key) || (v.kind === 'session' && !v.key && !v.pane)) {
    api().log(`window: setView(${v.kind}) with no session: nothing to show`);
    return;
  }
  if (v.kind === 'session') v = { kind: 'tab', id: tabForSession(v.key, v.pane) };
  else if (v.kind === 'pane') v = { kind: 'tab', id: tabForPane(v.socket, v.pane, v.name) };
  // A split's pane: its tab, with that pane focused.
  if (v.kind === 'tab') {
    const vid = v.id;
    const t = S.tabs.find((x) => x.id === vid);
    const h0 = t ? hostOf(t) : null;
    if (h0 && h0.split) { h0.split.focus = 1; v = { kind: 'tab', id: h0.id }; }
  }
  if (v.kind !== 'start') npmAsked = null;
  if (S.view.kind === 'page' && v.kind !== 'page') pages.close();
  if (S.view.kind === 'machines' && v.kind !== 'machines') machinesView.hide();
  if (v.kind !== 'review' && S.view.kind === 'review') review.key = null;
  S.view = v;
  const learnOf: Partial<Record<string, LearnKey>> = { picker: 'pick', review: 'review', decisions: 'decisions' };
  if (learnOf[v.kind]) markUsed(learnOf[v.kind]!);
  if (v.kind === 'picker') wantHint('pick');
  if (v.kind === 'tab') { const t = S.tabs.find((x) => x.id === (v as { id: string }).id); bells.delete(v.id); if (t?.split) bells.delete(t.split.guest); }
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
  // A session the board does not list yet has no key: its pane names it.
  const had = S.tabs.find((t) => (t.kind === 'session' && (key ? t.key === key : !!p && t.pane === p)) || (!!p && t.kind === 'shell' && t.pane === p));
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

/**
 * No pane in the middle. The terminals keep their panes, hidden (at most
 * POOL a slot, pools): coming back to one shows it at once, drawn.
 */
function hideTerms(): void {
  shownKeyB = '';
  layoutSplit(null);
}

// ---- each pane's terminal, kept while it is not on screen
// A tab switch used to attach the one xterm.js to the next pane: its
// screen went blank, or kept the pane before, until the next one's
// snapshot was written (a flash at each switch). Now each slot (0: a
// tab's own pane, 1: its split's) keeps up to POOL terminals, each attached
// to its pane and drawn under the one in front: a switch to one of them
// only swaps which shows. A pane with none takes the least lately shown,
// is drawn hidden, and shows once its screen is written.
const POOL = 4;
interface Pooled { view: TerminalView; marks: TerminalMarks; el: HTMLElement; used: number }
const pools: [Pooled[], Pooled[]] = [[], []];
const allViews = (): TerminalView[] => [...pools[0], ...pools[1]].map((p) => p.view);
const slotOf = (v: TerminalView): 0 | 1 => (pools[1].some((p) => p.view === v) ? 1 : 0);
/** The terminal in front of its slot (termA, or termB while the split shows), not one hidden in a pool. */
const inFront = (v: TerminalView): boolean => v === termA || (v === termB && !$('pbox1').hidden);

/** A terminal for slot to attach a pane to: the one already on that pane, else a free one, else a new one (up to POOL), else the least lately shown. */
function spareFor(slot: 0 | 1, pane: string): Pooled {
  const pool = pools[slot];
  const cur = slot ? termB : termA;
  const on = pool.find((p) => p.view.attached?.pane === pane);
  if (on) return on;
  const free = pool.find((p) => p.view !== cur && !p.view.attached);
  if (free) return free;
  if (pool.length < POOL) {
    const el = h('div.term-host.pooled');
    $(slot ? 'stack1' : 'stack0').appendChild(el);
    const [view, m] = makeView(el);
    const e = { view, marks: m, el, used: 0 };
    pool.push(e);
    return e;
  }
  const old = pool.filter((p) => p.view !== cur).sort((a, b) => a.used - b.used)[0];
  return old || pool[0];
}

/** Shows e in front of its slot: the one before goes under it, still on its pane. */
function swapIn(slot: 0 | 1, e: Pooled): void {
  e.used = Date.now();
  const cur = slot ? termB : termA;
  if (cur === e.view) return;
  const id = slot ? 'term2' : 'term';
  for (const p of pools[slot]) { p.el.classList.toggle('pooled', p !== e); if (p !== e && p.el.id === id) p.el.removeAttribute('id'); }
  e.el.id = id;
  // A size it waited for while hidden (terminal.ts fitLater), before this frame shows it.
  e.view.shown();
  const keys = term === cur;
  if (slot) { termB = e.view; marksB = e.marks; } else { termA = e.view; marksA = e.marks; }
  if (keys) { term = e.view; marks = e.marks; }
}

// ---- the split's layout (Split.js), its headers and its focus
let splitLib: SplitInstance | null = null;
let splitShape = '';
function layoutSplit(host: Tab | null): void {
  const g = guestOf(host);
  const sp = host && host.split && g ? host.split : null;
  const box = $('split');
  const b0 = $('pbox0'), b1 = $('pbox1');
  // The keyboard's terminal follows the focused pane.
  term = sp && sp.focus === 1 && termB ? termB : termA;
  marks = term === termB && marksB ? marksB : marksA;
  const shape = sp ? `${host!.id}|${sp.side}|${sp.zoom ? sp.focus : '-'}` : '';
  box.classList.toggle('two', !!sp && !sp.zoom);
  box.classList.toggle('down', !!sp && (sp.side === 'down' || sp.side === 'up'));
  box.classList.toggle('flip', !!sp && (sp.side === 'left' || sp.side === 'up'));
  b0.classList.toggle('focus', !!sp && sp.focus === 0);
  b1.classList.toggle('focus', !!sp && sp.focus === 1);
  b0.hidden = !!sp && !!sp.zoom && sp.focus === 1;
  b1.hidden = !sp || (!!sp.zoom && sp.focus === 0);
  $('phead0').hidden = !sp;
  if (sp) { renderPaneHead(0, host!); renderPaneHead(1, g!); }
  if (shape === splitShape) return;
  splitShape = shape;
  if (splitLib) { splitLib.destroy(); splitLib = null; }
  b0.style.flexBasis = ''; b1.style.flexBasis = '';
  if (!sp || sp.zoom) return;
  const els = sp.side === 'left' || sp.side === 'up' ? [b1, b0] : [b0, b1];
  const first = sp.side === 'left' || sp.side === 'up' ? 100 - sp.size : sp.size;
  splitLib = Split(els, {
    direction: sp.side === 'down' || sp.side === 'up' ? 'vertical' : 'horizontal',
    sizes: [first, 100 - first],
    minSize: 160,
    gutterSize: 6,
    snapOffset: 0,
    elementStyle: (_d, size, gutter) => ({ 'flex-basis': `calc(${size}% - ${gutter}px)` }),
    gutterStyle: (_d, gutter) => ({ 'flex-basis': `${gutter}px` }),
    onDragEnd: (sizes) => {
      const h = S.tabs.find((x) => x.id === host!.id);
      if (h && h.split) { h.split.size = Math.round(h.split.side === 'left' || h.split.side === 'up' ? sizes[1] : sizes[0]); save(); }
    },
  });
  const gut = box.querySelector('.gutter') as HTMLElement | null;
  if (gut) {
    gut.title = 'Drag to resize, double-click to even';
    gut.addEventListener('dblclick', () => { splitLib?.setSizes([50, 50]); const h = S.tabs.find((x) => x.id === host!.id); if (h && h.split) { h.split.size = 50; save(); } });
  }
}

/** A pane's header in a split tab: its name, the agent's badge, a close x. */
function renderPaneHead(i: 0 | 1, t: Tab): void {
  const l = tabLabel(t);
  const owner = t.kind === 'shell' && t.owner ? sessionOfPane(S.hub, t.owner) : null;
  const badge = t.kind === 'shell' && t.owner ? (assistantName(owner?.session.assistant || null) || 'Agent') : null;
  replace($(`phead${i}`),
    t.kind === 'shell' && !l.group ? h('span.ti', svg(I.SHELL)) : null,
    // An agent's pane: its name and the badge (the line "An agent's" would say it twice).
    h('b', l.name), l.sub && !badge ? h('span.t3', l.sub) : null,
    badge ? h('span.ag', badge) : null,
    h('span.sp'),
    h('button.x', { title: `Close pane (${shortcut('W')})`, 'aria-label': 'Close pane', on: { click: (e: Event) => { e.stopPropagation(); void closePane(t); } } }, svg(I.CLOSE)));
}

/** The split's second pane in termB (made when first needed). */
async function showGuest(host: Tab | null): Promise<void> {
  const g = guestOf(host);
  if (!g) { shownKeyB = ''; return; }
  const v = viewB();
  if (host!.split!.focus === 1) { term = v; marks = marksB!; }
  await showPane(`${g.socket}|${g.pane}`, () => daemons.get(g.socket), g.pane, (e) => { if (/^no answer after/.test(e.message)) return; removeTab(g.id); }, v);
}

/** The pane with the keyboard, in a split tab (0: the tab's own, 1: its split's). */
function focusSplit(i: 0 | 1): void {
  const host = tabOfView();
  if (!host || !host.split || !guestOf(host)) { term = termA; marks = marksA; term.focus(); return; }
  if (host.split.focus !== i) { host.split.focus = i; save(); }
  term = i === 1 && termB ? termB : termA;
  marks = term === termB && marksB ? marksB : marksA;
  layoutSplit(host);
  if (host.split.zoom) void renderCentre();
  term.focus();
  renderSidebar(); renderTabs(); renderStrip(); if (panelVisible()) renderPanel();
}

/** Closes a pane of the tab in front: its split's, or the tab's own (its split's pane then a tab of its own). */
async function closePane(t: Tab): Promise<void> {
  await askClose(t);
}

function show(id: 'term' | 'elsewhere' | 'start' | 'none' | 'review' | 'brief'): void {
  // The terminals: the split, laid out even while hidden (app.css #split[hidden]).
  const was = !!$('split').hidden;
  $('split').hidden = id !== 'term';
  if (id === 'term') for (const v of [termA, termB]) v?.shown(was);
  for (const k of ['elsewhere', 'start', 'none', 'review', 'brief']) ($(k) as HTMLElement).hidden = k !== id;
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

let shownKeyB = '';
const shownIn = (slot: 0 | 1) => (slot ? shownKeyB : shownKey);
const setShownIn = (slot: 0 | 1, k: string) => { if (slot) shownKeyB = k; else shownKey = k; };

/**
 * Shows a pane in view's slot. Its own terminal when it has one, drawn: at
 * once. Else one is attached hidden, and the terminals show once its
 * screen is written (at most VIEW_WAIT ms): the view before stays until
 * then. Hidden, the terminals are still laid out (app.css #split[hidden],
 * .term-host.pooled), so a pane is sized and drawn before it shows.
 */
async function showPane(key: string, get: () => Promise<RavenryClient | null>, pane: string, gone: (e: Error) => void, view: TerminalView = termA): Promise<void> {
  const slot = slotOf(view);
  const cur = slot ? termB! : termA;
  // Only when that very pane is on screen: an attempt that failed or hung
  // must not leave the pane before it there and make later clicks no-ops.
  if (shownIn(slot) === key && cur.attached && cur.attached.pane === pane && cur.ready) { show('term'); focusPending(); return; }
  setShownIn(slot, key);
  const e = spareFor(slot, pane);
  if (e.view.attached?.pane === pane && e.view.ready && e.view.isDrawn) {
    swapIn(slot, e);
    show('term');
    if (e.view === term) e.view.focus();
    focusPending();
    return;
  }
  let shown = false;
  // The keyboard goes to it once it shows (a hidden terminal cannot take it).
  const reveal = () => {
    if (shown || shownIn(slot) !== key) return;
    shown = true;
    swapIn(slot, e);
    show('term');
    if (e.view === term) e.view.focus();
  };
  const cap = setTimeout(reveal, VIEW_WAIT);
  try {
    const client = await within(get(), 8000, 'looking for the daemon that holds it');
    if (!client) throw new Error('no running daemon holds its pane');
    if (shownIn(slot) !== key) { clearTimeout(cap); return; }
    await within(e.view.show({ client, pane }, false), 8000, `attaching to pane ${pane}`);
    void e.view.drawn.then(() => { clearTimeout(cap); reveal(); });
    void paneScrollback(client, pane);
  } catch (err) {
    clearTimeout(cap);
    reveal();
    if (shownIn(slot) !== key) return;
    setShownIn(slot, '');
    e.view.hide();
    const why = (err as Error).message || String(err);
    api().log(`window: could not show pane ${pane}: ${why}`);
    gone(err as Error);
  }
  focusPending();
}

// ---- a view is drawn whole, or the one before it stays
// A view that waits on the hub (a brief, a project's last conversation, a
// page, an in-app page, a session's screen in another terminal, Start's
// folders) is read before it shows: the view before it stays on screen
// until then (at most VIEW_WAIT ms, then it shows with what it has), so
// no view shows empty and fills in a moment later. A pointer resting on
// what opens a view reads it already (prepareFrom), so most switches draw
// at once.
const VIEW_WAIT = 300;
let viewGate: { key: string; until: number } | null = null;

function viewWaitsOn(v: View): Promise<unknown> | null {
  if (v.kind === 'page') return pages.wait(v.key);
  if (v.kind === 'brief') return briefData.has(v.project) ? null : fetchBrief(v.project);
  if (v.kind === 'project') {
    const p = (S.hub?.projects || []).find((x) => x.id === v.id);
    if (!p || p.sessions.some((x) => !x.handed)) return null;
    const c = lastConv.get(p.id);
    return c && !c.asking ? null : loadLast(p.id);
  }
  if (IN_KINDS.has(v.kind)) return inapp.wait(v as InView);
  if (v.kind === 'start') return startRead ? null : loadStart();
  if (v.kind === 'tab' || v.kind === 'session') {
    const key = v.kind === 'session' ? v.key : tabSessionKey(S.tabs.find((t) => t.id === v.id) || null);
    const f = key ? findSession(S.hub, key) : null;
    return f ? liveWaitsOn(f.project, f.session) : null;
  }
  return null;
}

/** Reads what v shows ahead (the pointer rests on what opens it). */
function prepareView(v: View): void { void viewWaitsOn(v); }
const prepOf = (v: View): string => JSON.stringify(v);

/**
 * The pointer on what opens a view reads that view ahead: a sidebar row
 * (a session, a project, a page), or a control that names its view
 * (data-prep). A click comes a moment later and draws it at once.
 */
let prepAt: Element | null = null;
function prepareFrom(target: EventTarget | null): void {
  const el = target instanceof Element ? target.closest('[data-prep], #side [data-key], #side [data-page]') : null;
  if (!el || el === prepAt) return;
  prepAt = el;
  const prep = el.getAttribute('data-prep');
  if (prep) { try { prepareView(JSON.parse(prep) as View); } catch { /* not a view */ } return; }
  const page = el.getAttribute('data-page');
  if (page) { if (page !== 'decisions' && page !== 'machines') prepareView({ kind: 'page', key: page }); return; }
  const key = el.getAttribute('data-key') || '';
  if (key.startsWith('project:')) {
    // A project's row opens its main session when one runs (pickProject), else the project.
    const p = (S.hub?.projects || []).find((x) => x.id === key.slice(8));
    const s = p ? p.sessions.find((x) => x.surfaceId === p.primary && !x.handed) || p.sessions.find((x) => !x.handed) : null;
    prepareView(p && s ? { kind: 'session', key: `${p.id}/${s.surfaceId}` } : { kind: 'project', id: key.slice(8) });
  }
  else if (key && !key.startsWith('tab:')) prepareView({ kind: 'session', key });
}

/** The session's screen in another terminal, read before its view shows; null when it shows no screen or has it. */
function liveWaitsOn(p: HubProject, s: HubSession): Promise<unknown> | null {
  if (paneOf(s) && !machineOf(p, s)) return null;
  if (s.terminal === false || s.surfaceId.startsWith('ev:')) return null;
  return liveCache.has(s.surfaceId) ? null : fetchLive(s.surfaceId);
}

/**
 * True while the view in front waits on what it shows: the window as it
 * was (its tabs, its panel, its middle) stays whole until then, and is
 * drawn again once it comes (or after VIEW_WAIT ms, with what it has).
 */
function holdView(): boolean {
  const v = S.view;
  const wait = viewWaitsOn(v);
  if (!wait) { viewGate = null; return false; }
  const k = viewKey(v);
  if (!viewGate || viewGate.key !== k) {
    viewGate = { key: k, until: Date.now() + VIEW_WAIT };
    const go = () => { if (viewGate && viewGate.key === k && viewKey(S.view) === k) render(); };
    void wait.then(go, go);
    setTimeout(go, VIEW_WAIT + 10);
  }
  return Date.now() < viewGate.until;
}

async function renderCentre(): Promise<void> {
  const v = S.view;
  if (holdView()) return;
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
  $('learn').hidden = v.kind !== 'learn' || !!need;
  $('inapp').hidden = !IN_KINDS.has(v.kind) || !!need;
  if (!IN_KINDS.has(v.kind)) inapp.hide();
  if (WIDE_VIEWS.has(v.kind)) { film.close(); }
  if (need) { hideTerms(); shownKey = ''; show('start'); renderStart(); return; }
  if (onPage) { hideTerms(); shownKey = ''; pages.show(v.key); return; }
  if (onMachines) { hideTerms(); shownKey = ''; machinesView.show(); return; }
  if (v.kind === 'decisions') { hideTerms(); shownKey = ''; decisions.render(); return; }
  if (v.kind === 'learn') { hideTerms(); shownKey = ''; renderLearn($('learn'), learnHost, v.lit || null); return; }
  if (IN_KINDS.has(v.kind)) { hideTerms(); shownKey = ''; inapp.show(v as InView); return; }
  if (v.kind === 'picker') {
    hideTerms(); shownKey = '';
    const k = S.cps.get(v.cp);
    if (!k) { setView(v.back); return; }
    picker.show(k);
    return;
  }
  if (v.kind === 'grid') {
    hideTerms(); shownKey = '';
    const p = (S.hub?.projects || []).find((x) => x.id === v.project);
    files.grid($('grid'), v.project, p ? p.name : v.project, () => setView(v.back));
    return;
  }
  if (v.kind === 'review') {
    const f = findSession(S.hub, v.key);
    if (!f || !f.session.worktree) { setView({ kind: 'session', key: v.key }); return; }
    hideTerms(); shownKey = '';
    show('review');
    review.show(v.key, f.project, f.session);
    renderStrip();
    return;
  }
  if (v.kind === 'project') {
    hideTerms(); shownKey = '';
    show('none');
    renderProject(v.id);
    renderStrip();
    return;
  }
  if (v.kind === 'brief') {
    hideTerms(); shownKey = '';
    show('brief');
    void renderBrief(v.project);
    renderStrip();
    return;
  }
  if (npmTakesCentre() || firstRun() || v.kind === 'start') { hideTerms(); shownKey = ''; show('start'); renderStart(); return; }
  if (v.kind === 'none') { hideTerms(); shownKey = ''; show('none'); renderNone(); focusPending(); return; }
  if (v.kind === 'pane') {
    await showPane(`pane|${v.socket}|${v.pane}`, () => daemons.get(v.socket), v.pane, (e) => { setView(S.tabs[0] ? { kind: 'tab', id: S.tabs[0].id } : { kind: 'none' }); toast(`That pane is gone: ${e.message}`); });
    return;
  }
  const t = tabOfView();
  if (t && t.kind === 'shell') {
    // A shell whose daemon did not answer in time stays a tab: only one that is gone closes.
    layoutSplit(t);
    void showGuest(t);
    await showPane(`${t.socket}|${t.pane}`, () => daemons.get(t.socket), t.pane, (e) => { if (/^no answer after/.test(e.message)) { toast(`Could not show that shell: ${e.message}`); return; } removeTab(t.id); if (!replacedPanes.has(t.pane)) toast(`That shell is gone: ${e.message}`); });
    return;
  }
  // The tab's own session (its split's pane may run another).
  const key = v.kind === 'tab' ? tabSessionKey(t) : viewSessionKey();
  const f = key ? findSession(S.hub, key) : null;
  const pane = f ? paneOf(f.session) : v.kind === 'session' ? v.pane || null : t && t.kind === 'session' ? t.pane || null : null;
  if (pane && (!f || !machineOf(f.project, f.session))) {
    layoutSplit(t);
    void showGuest(t);
    // A session the hub runs in a ravenryd pane here shows its pane.
    // Gone: said once, and a shell in front (one opened if none is), so the
    // middle never keeps asking for a pane that is not there.
    await showPane(`session|${pane}`, () => daemons.holding(pane), pane, (e) => {
      if (!replacedPanes.has(pane)) toast(`Could not show that session: ${e.message}`);
      const front = tabOfView();
      if (!front || front.kind !== 'session' || tabSessionKey(front) !== key) return;
      // Its tab goes (its pane is gone); a shell comes to the front.
      removeTab(front.id);
      const sh = S.tabs.find((x) => x.kind === 'shell');
      if (sh) setView({ kind: 'tab', id: sh.id }); else void newShell();
    });
    return;
  }
  hideTerms();
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
/** Each surface's screen as last read: its view draws from it at once while it is read again. */
const liveCache = new Map<string, { ver: number; entries: LiveEntry[] }>();
const liveLoading = new Map<string, Promise<void>>();
function fetchLive(surface: string): Promise<void> {
  const was = liveLoading.get(surface);
  if (was) return was;
  const p = (async () => {
    try {
      const r = await api().hubGet(`/api/live?surface=${encodeURIComponent(surface)}`) as { ver?: number; entries?: LiveEntry[] };
      if (r.entries) liveCache.set(surface, { ver: r.ver || 0, entries: r.entries });
    } catch { /* drawn from its transcript */ }
  })().finally(() => liveLoading.delete(surface));
  liveLoading.set(surface, p);
  return p;
}

function liveFollow(surface: string): void {
  if (live.surface === surface && live.timer) return;
  liveStop();
  live.surface = surface;
  const had = liveCache.get(surface);
  if (had) { live.ver = had.ver; live.entries = had.entries; }
  const poll = async (): Promise<void> => {
    if (live.surface !== surface) return;
    try {
      const r = await api().hubGet(`/api/live?surface=${encodeURIComponent(surface)}${live.ver ? `&v=${live.ver}` : ''}`) as { ver?: number; same?: boolean; entries?: LiveEntry[] };
      if (live.surface !== surface) return;
      if (!r.same && r.entries) {
        live.ver = r.ver || 0;
        live.entries = r.entries;
        liveCache.set(surface, { ver: live.ver, entries: r.entries });
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

/** Start's folders and assistants being read (its view waits on them the first time). */
let startLoading: Promise<void> | null = null;
let startRead = false;
function loadStart(): Promise<void> {
  if (!startLoading) startLoading = readStart().finally(() => { startLoading = null; startRead = true; });
  return startLoading;
}
/**
 * The Start screen's folders and assistants, from the hub (GET
 * /api/setup/start: the folders it knows first, then the ones that look
 * like projects, and `want` first when asked). While the board is not up
 * the app runs the same module itself, without the board's folders.
 */
async function startView(want?: string | null): Promise<StartView> {
  if (S.hubStatus?.reachable) {
    try { return await api().hubGet(`/api/setup/start${want ? `?folder=${encodeURIComponent(want)}` : ''}`) as StartView; } catch { /* the board went: below */ }
  }
  return api().startLocal(want || undefined);
}
async function readStart(): Promise<void> {
  const want = startIn;
  const { root, folders, assistants } = await startView(want);
  if (want) {
    S.start.folder = want;
    startIn = null;
  }
  S.start.folders = folders;
  S.start.root = root;
  if (!S.start.folder || !folders.some((f) => f.path === S.start.folder)) S.start.folder = folders[0]?.path || S.start.folder;
  S.start.assistants = assistants;
  const ready = assistants.find((a) => a.found && a.signedIn) || assistants.find((a) => a.found);
  if (!S.start.assistant || !assistants.some((a) => a.kind === S.start.assistant && a.found)) S.start.assistant = ready ? ready.kind : null;
  if (firstRun() || S.view.kind === 'start') renderStart();
}

/**
 * Step 2 of starting a session, once per assistant (A2): Ravenry's hooks
 * (it tells Ravenry when it needs you) and the Ravenry skill, both ticked.
 * Null when it was answered before, or both are on already.
 */
async function setupStep(kind: 'claude' | 'codex'): Promise<SetupStep | null> {
  if (S.setupAsked[kind]) return null;
  let rows: SkillRow[] = [];
  try { rows = await api().skills.get(); } catch { /* none */ }
  const r = rows.find((x) => x.kind === kind);
  if (!r) return null;
  const hooksOn = r.hooks === 'on', skillOn = r.ours || r.installed;
  if (hooksOn && skillOn) return null;
  return { kind, hooks: r.hooks !== 'unavailable', skill: !r.installed, hooksOn, skillOn, hooksFile: r.hooksFile, skillDir: r.dir, busy: false, error: null };
}

async function answerSetup(yes: boolean): Promise<void> {
  const su = S.setup;
  if (!su) return;
  if (yes) {
    su.busy = true; su.error = null; renderStart();
    const done: string[] = [];
    if (su.hooks && !su.hooksOn) {
      const r = await api().skills.setHooks(su.kind, true);
      if (!r.ok) { su.busy = false; su.error = `Could not set up the hooks: ${r.error}`; renderStart(); return; }
      done.push('hooks');
    }
    if (su.skill && !su.skillOn) {
      const r = await api().skills.set(su.kind, true);
      if (!r.ok) { su.busy = false; su.error = `Could not install the skill: ${r.error}`; renderStart(); return; }
      done.push('skill');
    }
    api().log(`window: step 2 for ${su.kind}: set up ${done.join(' and ') || 'nothing'}`);
  } else api().log(`window: step 2 for ${su.kind}: not now`);
  onbMark('setup', su.kind);
  S.setup = null;
  setupReady = true;
  void loadSetupLines();
  await startSession();
}
/** Step 2 was answered for the session about to start: Start goes on to it. */
let setupReady = false;

/** Per assistant, what is set up (the panel's two lines, B). */
let setupLines: Partial<Record<'claude' | 'codex', { hooks: boolean; skill: boolean }>> = {};
let setupAt = 0;
let setupLoading = false;
function takeSetupLines(rows: SkillRow[]): void {
  const next = Object.fromEntries(rows.filter((r) => r.found).map((r) => [r.kind, { hooks: r.hooks === 'on', skill: r.installed }]));
  const changed = JSON.stringify(next) !== JSON.stringify(setupLines);
  setupLines = next;
  setupAt = Date.now();
  if (changed && panelVisible()) renderPanel();
}
async function loadSetupLines(): Promise<void> {
  setupLoading = true;
  try { takeSetupLines(await api().skills.get()); } catch { /* none */ } finally { setupLoading = false; }
}
/** The setup lines as they are now: hooks or the skill set up since (in Settings, by an agent, by hand) show within seconds. */
function setupLinesFor(kind: 'claude' | 'codex'): { hooks: boolean; skill: boolean } | null {
  if (!setupLoading && Date.now() - setupAt > 5000) void loadSetupLines();
  return setupLines[kind] || null;
}

/** Step 2, in the start screen's place (A2). */
function setupCard(su: SetupStep): HTMLElement {
  const st = S.start;
  const who = assistantName(su.kind) || 'The assistant';
  const folderName = st.folder ? base(st.folder) : 'your folder';
  const tick = (key: 'hooks' | 'skill', on: boolean, disabled: boolean) => h(`button.ob-tick${on ? '.on' : ''}`, { role: 'checkbox', 'aria-checked': on ? 'true' : 'false', disabled, 'data-line': key, on: { click: () => { su[key] = !su[key]; renderStart(); } } }, on ? svg(I.CHECK) : null);
  const hooksLine = h('div.ob-r', { 'data-line': 'hooks' },
    tick('hooks', su.hooksOn || su.hooks, su.hooksOn || !su.hooksFile || su.busy),
    h('div.ob-c',
      h('span.h', `Know when ${who} waits for you`),
      h('p', `${who}\u2019s sessions tell Ravenry when they ask you something, finish or hand off, so they move to Needs you and can alert you.`),
      su.hooksOn ? h('span.ob-m.ok', 'Already set up') : su.hooksFile ? h('span.ob-m', `Adds a line to ${su.hooksFile}`) : h('span.ob-m', 'Needs Ravenry\u2019s board running; Settings can do it later.')));
  const skillLine = h('div.ob-r', { 'data-line': 'skill' },
    tick('skill', su.skillOn || su.skill, su.skillOn || su.busy),
    h('div.ob-c',
      h('span.h', 'Install the Ravenry skill', h('span.ob-new', 'New')),
      h('p', `${who} can open panes beside it, read their screens, show you pictures to pick from, and ask you through the board and your phone. The skill runs `, h('code', 'ravenry skill'), ', so it always matches this version.'),
      su.skillOn ? h('span.ob-m.ok', 'Already installed') : h('span.ob-m', `Adds ${su.skillDir}`)));
  return h('div.fl.ob', { 'data-step': '2' },
    svg(I.APP_ICON),
    h('h2', `Let ${who} work with Ravenry`),
    h('p.lead', `One step before ${who} opens in ${folderName}. Both are on; you can change either later in Settings.`),
    h('div.fl-card',
      hooksLine, skillLine,
      h('div.fl-go',
        h('button.btn.pri', { disabled: su.busy, on: { click: () => void answerSetup(true) } }, 'Set them up'),
        h('button.btn.ghost', { disabled: su.busy, on: { click: () => void answerSetup(false) } }, 'Not now'),
        h('span.sp'),
        h('span.t3.small', `Then ${who} opens in ${folderName}`))),
    su.error ? h('p.err', su.error) : null,
    h('div.fl-foot', 'Each file is backed up first, and your other hooks and skills stay as they are.'),
    h('div.ob-steps', h('i'), h('i.on'), 'Step 2 of 2'));
}

/** The folder openStart was asked to start in (a project's), first among the picks. */
let startIn: string | null = null;

function openStart(folder?: string): void {
  if (npmPoint('Starting a session')) return;
  startIn = folder || null;
  S.setup = null;
  if (folder) S.start.folder = folder;
  S.start.error = null;
  void loadStart();
  setView({ kind: 'start' });
}

function renderStart(): void {
  // The switch from the npm board takes the first-launch place (npmswitch.ts).
  if (npmTakesCentre()) { renderNpmCentre($('start')); return; }
  // The hub waits for macOS to say whether it may read a folder.
  if (S.hubStatus?.starting) { replace($('start'), accessCard(S.hubStatus.starting)); return; }
  const need = npmNeed();
  if (need) { renderNpmPointer($('start'), need, { url: S.config?.hubUrl || 'http://localhost:4600', reachable: !!S.hubStatus?.reachable, newShell: () => void newShell(), openUrl: (u) => api().openExternal(u) }); return; }
  const st = S.start;
  if (S.setup) { replace($('start'), setupCard(S.setup)); return; }
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
    h('span.t3.small', `${newSessionKey()} starts another one any time`),
    !first ? h('span.sp') : null,
    !first ? h('button.btn.ghost', { on: { click: () => { const t = S.tabs[0]; setView(t ? { kind: 'tab', id: t.id } : { kind: 'none' }); } } }, 'Cancel') : null);

  const card = h('div.fl-card', { on: { dragover: (e: Event) => e.preventDefault(), drop: (e: Event) => onDrop(e as DragEvent) } }, folderRow, asstRow, why, go);
  replace($('start'), h('div.fl',
    svg(I.APP_ICON),
    h('h2', first ? 'Start your first session' : 'Start a session'),
    h('p.lead', 'Pick a folder and an assistant. It opens in a real terminal here, and the list on the left keeps every session in order, the ones that need you first.'),
    card,
    st.error ? h('p.err', st.error) : null,
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
    // Step 2, once per assistant: its hooks and the skill (A2).
    if (a && !setupReady) {
      const su = await setupStep(a.kind);
      if (su) { S.setup = su; return; }
    }
    setupReady = false;
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
  if (S.view.kind === 'project') return `project:${S.view.id}`;
  const key = viewSessionKey();
  if (key && findSession(S.hub, key)) return key;
  const t = focusedTab();
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
  } else if (key && key.startsWith('project:')) {
    const p = (S.hub?.projects || []).find((x) => x.id === key.slice(8));
    [head, body] = p ? projectPanel(p) : [panelHead('Project', null), [h('p.t3.small', 'That project is no longer on the board.')]];
    if (p) shows = 'project';
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
      // A session just started, before the board lists it (B): its folder,
      // its assistant and what is set up for it.
      else if (t && t.kind === 'session' && t.pane && store.get(t.pane)) { [head, body] = newSessionPanel(t.pane); shows = 'new-session'; }
      else [head, body] = [panelHead('Session', null), [h('p.t3.small', 'Pick a session on the left to see its context, hand-off and brief here.')]];
    }
  }
  el.dataset.shows = shows;
  // A press held on a button of the panel: drawn again after its click
  // (patch swaps every section for a new one, and the click would be lost).
  if (heldIn(el, renderPanel)) return;
  patch(el, [head, panelBody]);
  patch(panelBody, body);
  cutAtWords(panelBody);
  clearHiddenSecrets(true);
}

/**
 * The hand-off card's line in its two lines, cut at a word with "…" where it runs past them (.ho-line's clamp
 * alone cuts inside a word): the longest run of its words that fits, as drawn now.
 */
function cutAtWords(root: Element): void {
  for (const el of root.querySelectorAll<HTMLElement>('.ho-line')) {
    if (!el.clientHeight || el.scrollHeight <= el.clientHeight + 1) continue;
    const words = (el.textContent || '').split(' ');
    const upTo = (n: number) => words.slice(0, n).join(' ').replace(/[\s,;:(\-\u2013[{]+$/, '') + '\u2026';
    let lo = 1, hi = words.length - 1, best = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      el.textContent = upTo(mid);
      if (el.scrollHeight <= el.clientHeight + 1) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    el.textContent = upTo(best);
  }
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

/** What a project says of itself while no session runs in it: why it is in its section, its brief's goal and next step. */
function projectFacts(p: HubProject): (HTMLElement | null)[] {
  const g: Group = ['you', 'work', 'wait', 'idle'].includes(p.state) ? p.state : 'idle';
  const t = p.planGate?.question ? `Needs you: ${p.planGate.question}`
    : g === 'wait' ? (p.waitingOn ? `Waiting on ${p.waitingOn}` : 'Waiting on others')
      : g === 'you' ? 'Needs you' : g === 'work' ? 'Working'
        : `Idle${p.since ? ` for ${ago(p.since, now())}` : ''}`;
  return [
    h(`div.st.c-${g}`, svg(RING[g]), t),
    p.brief?.goal ? h('div.sec', h('p.t3.small', 'Goal'), h('p', p.brief.goal)) : null,
    p.brief?.next ? h('div.sec', h('p.t3.small', 'Next'), h('p', p.brief.next)) : null,
  ];
}

/** A project's last conversation (the hub's /api/project/last), as its page shows it. */
interface LastConversation {
  sessionId: string; assistant: string; title: string; stoppedAt: string | null;
  lastPrompt: string | null; lastText: string | null; folder: string; folderShort: string; command: string;
  openIn: { ravenry: boolean; pane?: string; name?: string } | null;
}
/** By project id: what the hub said (null: none found), when it was asked, and an error to say. */
const lastConv = new Map<string, { at: number; last: LastConversation | null; busy?: boolean; error?: string | null; asking?: boolean }>();

const lastLoading = new Map<string, Promise<void>>();
function loadLast(id: string, force = false): Promise<void> {
  const was = lastLoading.get(id);
  if (was) return was;
  const c = lastConv.get(id);
  if (c && (c.asking || (!force && Date.now() - c.at < 15000))) return Promise.resolve();
  const p = readLast(id, c).finally(() => lastLoading.delete(id));
  lastLoading.set(id, p);
  return p;
}
async function readLast(id: string, c: { last: LastConversation | null } | undefined): Promise<void> {
  lastConv.set(id, { at: Date.now(), last: c ? c.last : null, asking: true });
  let last: LastConversation | null = null;
  try { const r = await api().hubGet(`/api/project/last?projectId=${encodeURIComponent(id)}`) as { last?: LastConversation | null }; last = r.last || null; } catch { last = c ? c.last : null; }
  lastConv.set(id, { at: Date.now(), last, asking: false });
  if (S.view.kind === 'project' && S.view.id === id) render();
}

/** "Thu 5 Nov, 00:14", as the page says when a conversation stopped. */
function stoppedWhen(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
  return `${day}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function projectPanel(p: HubProject): [HTMLElement, (HTMLElement | null)[]] {
  const c = lastConv.get(p.id);
  const last = c ? c.last : null;
  return [panelHead(p.name, null, null, p.machine || null), [
    ...projectFacts(p),
    c && !c.asking ? (last
      ? h('div.sec', { 'data-last': last.sessionId }, h('div.sec-h', 'Last conversation'), h('p', last.title), h('p.t3.small', `${assistantName(last.assistant) || 'Claude'}, stopped ${stoppedWhen(last.stoppedAt)}`))
      : h('div.sec', h('p.t3.small', 'No conversation found in this folder.'))) : null,
    p.folderShort ? h('div.sec', h('p.t3.small', p.folderShort)) : null,
  ]];
}

/** Continue: the conversation resumes in a Ravenry pane, in its folder (the hub's /api/sessions/resume). */
async function continueLast(p: HubProject, last: LastConversation): Promise<void> {
  const c = lastConv.get(p.id);
  if (!c || c.busy) return;
  c.busy = true; c.error = null; render();
  api().log(`window: project page ${p.id}: continue ${last.sessionId}`);
  try {
    const r = await api().hubCall('POST', '/api/sessions/resume', { projectId: p.id, sessionId: last.sessionId, cols: term.term.cols, rows: term.term.rows }) as { status: number; body: { surfaceId?: string; pane?: { id?: string }; projectId?: string; error?: string; open?: boolean } };
    const b = r.body || {};
    if (r.status !== 200) {
      // Still open in another terminal: the page says where, with Move here.
      if (b.open) { await loadLast(p.id, true); c.error = null; }
      else c.error = b.error || 'It could not be continued.';
      return;
    }
    const pane = b.pane && typeof b.pane.id === 'string' ? b.pane.id : null;
    setView({ kind: 'session', key: b.projectId && b.surfaceId ? `${b.projectId}/${b.surfaceId}` : '', ...(pane ? { pane } : {}) });
  } catch (e) { c.error = `It could not be continued: ${(e as Error).message}`; }
  finally { c.busy = false; render(); }
}

/** Move here: it ends where it still runs and goes on in a Ravenry pane (the hub's /api/sessions/move). */
async function moveLast(p: HubProject, last: LastConversation): Promise<void> {
  const c = lastConv.get(p.id);
  if (!c || c.busy) return;
  c.busy = true; c.error = null; render();
  api().log(`window: project page ${p.id}: move here ${last.sessionId}`);
  try {
    const r = await api().hubCall('POST', '/api/sessions/move', { projectId: p.id, sessionId: last.sessionId, keep: 'ravenry', cols: term.term.cols, rows: term.term.rows }) as { status: number; body: { surfaceId?: string; pane?: { id?: string }; waiting?: boolean; name?: string; error?: string } };
    const b = r.body || {};
    if (r.status !== 200) { c.error = b.error || 'It could not be moved.'; return; }
    if (b.waiting) { toast(`It moves here once Claude finishes its turn in ${b.name || 'the other terminal'}.`); return; }
    if (b.surfaceId) setView({ kind: 'session', key: `${p.id}/${b.surfaceId}`, ...(b.pane && b.pane.id ? { pane: b.pane.id } : {}) });
  } catch (e) { c.error = `It could not be moved: ${(e as Error).message}`; }
  finally { c.busy = false; render(); }
}

/**
 * The middle for a project no session runs in (an idle or waiting row,
 * 2026-11-08 "for waiting and idle sessions they start from an empty
 * session?"): its last conversation, to continue it (variant A of
 * ravenry-continue.html); else New session here.
 */
function renderProject(id: string): void {
  const p = (S.hub?.projects || []).find((x) => x.id === id);
  if (!p) { redraw($('none'), h('div.none-card', h('p', 'That project is no longer on the board.'))); return; }
  const s = p.sessions.find((x) => !x.handed);
  if (s) {
    redraw($('none'), h('div.none-card.project', { 'data-project': p.id }, h('p', h('b', p.name)), p.folderShort ? h('p.t3', p.folderShort) : null, projectFacts(p)[0], h('p', 'A session runs in it.'),
      h('div.row', h('button.btn.pri', { on: { click: () => pickSession(`${p.id}/${s.surfaceId}`, 'project page') } }, 'Show the session'))));
    return;
  }
  const c = lastConv.get(p.id);
  if (!c || Date.now() - c.at > 15000) void loadLast(p.id);
  const brief = p.brief ? h('button.lk', { 'data-prep': prepOf({ kind: 'brief', key: `project:${p.id}`, project: p.id }), on: { click: () => setView({ kind: 'brief', key: `project:${p.id}`, project: p.id }) } }, 'Open brief') : null;
  const newHere = p.folder && !p.machine ? () => openStart(p.folder!) : null;
  const last = c ? c.last : null;
  if (!c || (c.asking && !last)) {
    redraw($('none'), h('div.pa', { 'data-project': p.id }, h('div.pa-in', h('div.pa-head', h('h2.pa-name', p.name), p.folderShort ? h('span.t3', p.folderShort) : null, projectFacts(p)[0]), h('p.t3', 'Looking for its last conversation...'))));
    return;
  }
  if (!last) {
    redraw($('none'), h('div.none-card.project', { 'data-project': p.id },
      h('p', h('b', p.name)), p.folderShort ? h('p.t3', p.folderShort) : null, projectFacts(p)[0],
      h('p', 'No earlier conversation found in this folder.'),
      h('div.row', newHere ? h('button.btn.pri', { on: { click: newHere } }, 'New session here') : null,
        p.brief ? h('button.btn', { 'data-prep': prepOf({ kind: 'brief', key: `project:${p.id}`, project: p.id }), on: { click: () => setView({ kind: 'brief', key: `project:${p.id}`, project: p.id }) } }, 'Open brief') : null)));
    return;
  }
  const who = assistantName(last.assistant) || 'Claude';
  const outside = last.openIn && !last.openIn.ravenry ? last.openIn.name || 'another terminal' : null;
  const inRavenry = last.openIn && last.openIn.ravenry ? last.openIn.pane || null : null;
  redraw($('none'), h('div.pa', { 'data-project': p.id }, h('div.pa-in',
    h('div.pa-head', h('h2.pa-name', p.name), p.folderShort ? h('span.t3', p.folderShort) : null, projectFacts(p)[0]),
    h('div.conv', { 'data-last': last.sessionId },
      h('div.conv-h', h('span.ti', last.title), h('span.as-tag', who), h('span.sp'), h('span.when.small', `Stopped ${stoppedWhen(last.stoppedAt)}`)),
      h('div.said',
        last.lastPrompt ? [h('span.who', 'You'), h('span.you', last.lastPrompt)] : null,
        last.lastText ? [h('span.who', who), h('span.ag', last.lastText)] : null)),
    outside ? h('p.still', `Still open in ${outside}.`) : null,
    h('div.acts',
      inRavenry ? h('button.btn.pri', { on: { click: () => setView({ kind: 'session', key: '', pane: inRavenry }) } }, 'Show it')
        : outside ? h('button.btn.pri', { disabled: !!c.busy, on: { click: () => void moveLast(p, last) } }, c.busy ? 'Moving...' : 'Move here')
          : h('button.btn.pri', { disabled: !!c.busy, on: { click: () => void continueLast(p, last) } }, c.busy ? 'Continuing...' : 'Continue this conversation'),
      newHere ? h('button.btn', { on: { click: newHere } }, 'New session') : null,
      h('span.sp'), brief),
    c.error ? h('p.err', c.error) : null,
    h('div.cmd', outside ? `Move here ends it in ${outside} and continues it in a Ravenry pane: ` : 'Continues it in a Ravenry pane: ', h('span.mono', last.command), ` in ${last.folderShort}`))));
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

  // What the first-launch step set up for its assistant (B), on this machine.
  const sl = !machineOf(p, s) && (s.assistant === 'claude' || s.assistant === 'codex') ? setupLinesFor(s.assistant) : null;
  if (sl && !k) body.push(h('div.sec.setup-lines', h('div.sec-h', 'This session'), ...setupLineEls(sl)));

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
    // The hand-off card (2026-11-12): the hub's line for the entry, at most two lines (.ho-line, an older hub's whole
    // entry too); "›" after the time, and a press opens the brief at its Hand-off.
    const openHandoff = () => { briefFocus = { project: p.id, section: 'handoff' }; setView({ kind: 'brief', key: `project:${p.id}`, project: p.id }); };
    body.push(h('div.sec.ho-card', { role: 'button', tabindex: '0', title: 'Open the brief at its Hand-off', on: { click: openHandoff, keydown: (e: Event) => { const k = (e as KeyboardEvent).key; if (k === 'Enter' || k === ' ') { e.preventDefault(); openHandoff(); } } } },
      h('div.sec-h', 'Hand-off', h('span.sp'), ho.when ? h('span.t3.light', ho.when) : null, h('span.t3.chev', '\u203a')),
      ho.text ? h('p.ho-line', ho.text) : null,
      p.handoffRecent ? h('div.chk', h('i', svg(I.CHECK)), 'Read by this session') : null));
  }

  const pics = p.brief?.pictures || [];
  const pic = pics.filter((x) => x.url).slice(-1)[0];
  if (pic && S.config) {
    body.push(h('div.sec',
      h('div.sec-h', 'Latest picture', h('span.sp'), h('button.lk', { 'data-prep': prepOf({ kind: 'gallery', project: p.id, at: null, back: { kind: 'none' } }), on: { click: () => setView({ kind: 'gallery', project: p.id, at: null, lit: 0, back: backFrom() }) } }, `Gallery${inapp.pictures(p).length > 1 ? ` (${inapp.pictures(p).length})` : ''}`)),
      h('img.shot', { src: S.config.hubUrl + pic.url, decoding: 'sync', 'data-prep': prepOf({ kind: 'gallery', project: p.id, at: 0, back: { kind: 'none' } }), alt: pic.alt || 'The latest picture this session showed', title: 'See it large', role: 'button', tabindex: '0', on: { click: () => setView({ kind: 'gallery', project: p.id, at: 0, back: backFrom() }), keydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') setView({ kind: 'gallery', project: p.id, at: 0, back: backFrom() }); } } }),
      pic.alt ? h('span.t3.small', pic.alt) : null));
  }

  if (p.brief && (p.brief.goal || p.brief.next)) {
    // The brief, short (H1): the goal on one line, Next as at most three
    // one-line items as the hub splits them (nextParts), and the whole of it
    // a click away (briefdoc.ts).
    const n = p.brief.nextParts || { items: [], older: 0 };
    body.push(h('div.sec.brief-card',
      h('div.sec-h', 'Brief'),
      h('div.bf',
        p.brief.goal ? [h('div.lbl', 'Goal'), h('div.gl', { title: p.brief.goal }, plain(p.brief.goal))] : null,
        n.items.length ? [h('div.lbl', 'Next'), h('ul', n.items.map((x) => h('li', { title: x }, h('span', x))))] : null,
        h('div.ft2', h('button.lk', { 'data-prep': prepOf({ kind: 'brief', key, project: p.id }), disabled: S.view.kind === 'brief' && S.view.key === key, title: S.view.kind === 'brief' && S.view.key === key ? 'The brief is open' : '', on: { click: () => setView({ kind: 'brief', key, project: p.id }) } }, 'Open brief'), n.older ? h('span.t3', `, ${n.older} older ${n.older === 1 ? 'entry' : 'entries'}`) : null))));
  }

  const plan = p.plan;
  body.push(h('div.sec',
    h('div.sec-h', 'Plan', h('span.sp'), h('span.t3.light', plan ? (p.planGate ? 'At a gate' : 'Running') : 'None running')),
    plan ? h('p', plan.title || plan.name || 'A plan is running.') : h('p.t2.small', 'Hand work over as steps; it runs on its own and stops at your gates.'),
    h('button.btn.sm.self', { 'data-prep': prepOf(plan ? { kind: 'plan', project: p.id, back: { kind: 'none' } } : { kind: 'newplan', project: p.id, back: { kind: 'none' } }), on: { click: () => setView(plan ? { kind: 'plan', project: p.id, title: plan.title || null, back: backFrom() } : { kind: 'newplan', project: p.id, back: backFrom() }) } }, plan ? 'Open the plan' : 'New plan')));

  return [head, body];
}

// The brief as a page in the middle (H2): read from the hub as written,
// drawn again only when its text changed (so the entries opened stay open),
// asked again at most every 4 s while it shows.
let briefShown: { project: string; text: string; at: number } | null = null;
/** A section the next draw of that project's brief scrolls to (the hand-off card's press). */
let briefFocus: { project: string; section: 'handoff' } | null = null;
/** The brief's heading for a section, by the names brief.mjs reads, scrolled to the top of the page. */
function focusBriefSection(el: HTMLElement, project: string): void {
  if (!briefFocus || briefFocus.project !== project) return;
  const names = ['hand-off', 'handoff', 'hand off', 'hand-backs'];
  const h2 = [...el.querySelectorAll('.md h2')].find((x) => names.includes((x.textContent || '').trim().toLowerCase())) as HTMLElement | undefined;
  briefFocus = null;
  if (h2) h2.scrollIntoView({ block: 'start' });
}
/** Each project's brief as the hub last gave it (the Brief page draws from it at once, and reads it again after 4 s). */
const briefData = new Map<string, { r: { status: number; body: unknown } | null; at: number }>();
const briefLoading = new Map<string, Promise<void>>();
function fetchBrief(project: string): Promise<void> {
  const was = briefLoading.get(project);
  if (was) return was;
  const p = (async () => {
    let r: { status: number; body: unknown } | null = null;
    try { r = await api().hubCall('GET', `/api/brief?project=${encodeURIComponent(project)}`); } catch { r = null; }
    briefData.set(project, { r, at: Date.now() });
  })().finally(() => briefLoading.delete(project));
  briefLoading.set(project, p);
  return p;
}

async function renderBrief(project: string): Promise<void> {
  const el = $('brief');
  const d = briefData.get(project);
  if (!d || Date.now() - d.at > 4000) {
    void fetchBrief(project).then(() => { if (S.view.kind === 'brief' && S.view.project === project && briefData.get(project) !== d) void renderBrief(project); });
    if (!d) { if (briefShown?.project !== project) { briefShown = null; replace(el); } return; }
  }
  const r = d.r;
  const b = r && r.status === 200 ? r.body as { file: string; path: string; text: string; nextParts?: NextParts; updatedAt: string; by: string | null } : null;
  const p = (S.hub?.projects || []).find((x) => x.id === project);
  if (!b) {
    briefShown = null;
    const why = (r && r.body && (r.body as { error?: string }).error) || 'The brief could not be read.';
    replace(el, h('div.doc-b', h('p.t3', String(why))));
    return;
  }
  const same = briefShown && briefShown.project === project && briefShown.text === b.text;
  briefShown = { project, text: b.text, at: Date.now() };
  if (same && el.firstChild) { focusBriefSection(el, project); return; }
  const dir = b.file.replace(/\/[^/]*$/, '');
  replace(el,
    h('div.doc-h', svg(I.DOC), h('b', 'Brief'), h('span.t3', p ? p.name : project), h('span.sp'),
      h('span.t3', { title: b.path }, `Updated ${clock(b.updatedAt, now())}${b.by ? ` by ${b.by}` : ''}`),
      p && p.machine ? null : h('button.btn.sm', { title: `Open ${b.path} in your Markdown editor`, on: { click: () => api().openPath(b.file) } }, 'Edit')),
    h('div.doc-b', briefPage(b.text, { dir, onLink: (u) => api().openExternal(u) }, b.nextParts?.entries || [])));
  focusBriefSection(el, project);
}

/** What a session's panel shows of Phase 2 between its card and its context. */
function sessionExtras(p: HubProject, s: HubSession, pane: string): (HTMLElement | null)[] {
  return [
    ...review.panelCards(p, s, () => setView({ kind: 'review', key: sessionKey(p.id, s) })),
    files.section(p.id, p.name, s.surfaceId),
    panesItUses(pane, paneCtx),
  ];
}

function newSessionPanel(pane: string): [HTMLElement, (HTMLElement | null)[]] {
  const p = store.get(pane)!.pane;
  // The board starts it as ravenry.session=<assistant> (a shell types its command).
  const lab = p.labels?.['ravenry.session'] || p.labels?.['ravenry.agent'] || base(p.command[0] || '');
  const kind = /codex/.test(lab) ? 'codex' : /claude/.test(lab) ? 'claude' : null;
  const sl = kind ? setupLinesFor(kind) : null;
  return [panelHead('New session', kind ? assistantName(kind) : null), [
    h('div.st.c-idle', svg(RING.idle), 'Ready for your first message'),
    h('div.sec.setup-lines',
      h('div.sec-h', 'This session'),
      h('div.kv.wide', h('span', 'Folder'), h('span.mono', tilde(p.cwd)), kind ? h('span', 'Assistant') : null, kind ? h('span', kind === 'claude' ? 'Claude Code' : 'Codex') : null),
      ...(sl ? setupLineEls(sl) : [])),
  ]];
}

/** The two lines of what is set up for an assistant (B): on, or off with the way to Settings. */
function setupLineEls(sl: { hooks: boolean; skill: boolean }): HTMLElement[] {
  const line = (on: boolean, yes: string, no: string, what: string) => on
    ? h('div.chk', { 'data-setup': what }, h('i', svg(I.CHECK)), yes)
    : h('div.chk.off', { 'data-setup': what }, h('i'), no, ' ', h('button.lk', { on: { click: () => api().settings.open('skills') } }, 'Settings'));
  // Its hooks (Simon's wording, 2026-11-11): what they do for the person, the same words as the Mac app's.
  return [line(sl.hooks, 'Tells you when it waits for you', 'Can\u2019t tell you when it waits for you.', 'hooks'),
    line(sl.skill, 'Has the Ravenry skill', 'Has no Ravenry skill.', 'skill')];
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
  markUsed('needs');
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
  // Each project's latest picture decoded before a panel shows it.
  if (S.config) for (const p of next.projects || []) { const pic = (p.brief?.pictures || []).filter((x) => x.url).slice(-1)[0]; if (pic) void preloadPicture(S.config.hubUrl + pic.url); }
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

/**
 * A bell in a pane not on screen: a small bell on its tab, the sound and
 * the Dock as the settings say. From the daemon's pane.bell, or from a
 * pooled terminal hidden on its pane (the daemon sends no pane.bell for a
 * pane the window streams).
 */
function paneRang(id: string): void {
  const t = S.tabs.find((x) => (x.kind === 'shell' && x.pane === id) || (x.kind === 'session' && (x.pane === id || x.key.endsWith(`/ravenry:${id}`))));
  const shown = allViews().some((v) => inFront(v) && v.attached?.pane === id);
  if (t && !shown) { bells.add(t.host || t.id); renderTabs(); }
  if (!shown && termSettings?.bell !== 'off') api().settings.bell();
}

/** A tab not on screen printed: a quiet dot on it (pane.activity, or a pooled terminal hidden on its pane). */
function panePrinted(t: ShellTab | undefined): void {
  if (t && !t.activity && tabOfView() !== t) { t.activity = true; renderTabs(); }
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
    case 'pane.bell': paneRang(e.pane.id); return;
    case 'pane.activity': panePrinted(shellTabOf(socket, e.pane.id)); return;
    case 'pane.created': case 'pane.updated': {
      // A plain shell another window or the command line made.
      // (Each window its own: one opened with Cmd+N labels its shells with its id.)
      if (e.pane.labels?.['ravenry.kind'] === 'shell' && e.pane.state === 'running' && !shellTabOf(socket, e.pane.id) && (e.pane.labels?.['ravenry.window'] || null) === thisWindow) addShellTab(socket, e.pane, null, false);
      // An agent's own pane: a tab right after its session's, the front left alone.
      else if (agentPane(e.pane) && !shellTabOf(socket, e.pane.id)) { splitAgentPane(addAgentPaneTab(socket, e.pane)); save(); render(); }
      // pane.created can come before the daemon has recorded who made the
      // pane: asked once more, from the pane list.
      else if (e.event === 'pane.created' && !e.pane.creator && e.pane.labels?.['ravenry.kind'] !== 'shell') {
        const id = e.pane.id;
        void daemons.get(socket).then((c) => c.request('pane.list', {})).then(({ panes }) => {
          const p = panes.find((x) => x.id === id);
          if (p && agentPane(p) && !shellTabOf(socket, id)) { splitAgentPane(addAgentPaneTab(socket, p)); save(); render(); }
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
    for (const cp of checkpoints) {
      // The person's own typing, taken for an agent's while this window was
      // judged inside a pane (2026-11-07: opened with `open -a` from a pane):
      // a drive "asked" by a connection named as this app is no question.
      // Withdrawn once the window is the person again (a daemon from 0.1.15
      // does it itself; an older one keeps it until asked).
      if (client.hello.person !== false && cp.state === 'open' && cp.kind === 'drive' && cp.drive?.agent?.client === 'ravenry-desktop') {
        void client.request('checkpoint.cancel', { checkpoint: cp.id, reason: 'typed by the person in the Ravenry window, which was taken for a program in a pane' }).catch(() => {});
        continue;
      }
      onCheckpoint(socket, cp);
    }
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
    case 'learn': openLearn(); break;
    // Cmd+W: the pane with the keyboard (its tab, or its split's pane).
    case 'close-tab': { const t = focusedTab(); if (t) void askClose(t); break; }
    // Cmd+D / Cmd+Shift+D: a new shell beside or under the pane in front.
    case 'split': void splitNew(arg === 'down' ? 'down' : 'right'); break;
    // Cmd+Option+arrows: the other pane of the split.
    case 'focus-pane': { const host = tabOfView(); if (host && host.split) { const sd = host.split.side; const toGuest = (arg === 'right' && sd === 'right') || (arg === 'left' && sd === 'left') || (arg === 'down' && sd === 'down') || (arg === 'up' && sd === 'up'); const toHost = (arg === 'left' && sd === 'right') || (arg === 'right' && sd === 'left') || (arg === 'up' && sd === 'down') || (arg === 'down' && sd === 'up'); if (toGuest) focusSplit(1); else if (toHost) focusSplit(0); } break; }
    // Cmd+Shift+Enter: the focused pane alone, and back.
    case 'zoom-pane': { const host = tabOfView(); if (host && host.split) { host.split.zoom = !host.split.zoom; save(); layoutSplit(host); void renderCentre(); } break; }
    case 'next-tab': stepTab(Number(arg) || 1); break;
    // The app's own words for the person (an update that stopped trying): kept until OK.
    case 'update-stopped': showToast(String(arg || ''), [{ label: 'Try again', run: () => api().retryUpdate() }], { key: 'update-stopped', ms: Infinity }); break;
    case 'tab': { const t = stripTabs()[Number(arg)]; if (t) setView({ kind: 'tab', id: t.id }); break; }
    case 'toggle-panel': togglePanel(); break;
    // Cmd+= / Cmd+- / Cmd+0: the terminals' text size, written to the
    // settings (every window follows through onChange).
    case 'zoom': {
      const step = Number(arg) || 0;
      const cur = termSettings?.xterm.fontSize || FONT_SIZE.base;
      const size = Math.max(FONT_SIZE.min, Math.min(FONT_SIZE.max, step === 0 ? FONT_SIZE.base : cur + step));
      if (size !== cur) void api().settings.set({ fontSize: size });
      break;
    }
    case 'find': openFind(); break;
    case 'find-next': if (find.open && find.query) runFind(1, false); else openFind(); break;
    case 'find-prev': if (find.open && find.query) runFind(-1, false); else openFind(); break;
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

/**
 * Checkpoints whose words this window lacks (a daemon's copy, or one that
 * moved on since): the hub words them (POST /api/checkpoints/words), and
 * their cards are drawn when the words come.
 */
function askWords(): void {
  const want = S.cps.wordsWanted();
  if (!want.length) return;
  api().hubPost('/api/checkpoints/words', wordsBody(want)).then((r) => {
    const words = (r as { words?: Record<string, NonNullable<HubCheckpoint['words']>> } | null)?.words || {};
    const got = S.cps.setWords(words);
    S.cps.wordsFailed(want.filter((c) => !words[c.id]));
    if (got) render();
  }, () => S.cps.wordsFailed(want));
}

function render(): void {
  askWords();
  dropFrontToast();
  document.body.classList.toggle('mac', isMac());
  document.body.classList.toggle('first', firstRun());
  renderSidebar();
  // The next view waits on the hub: the rest of the window stays as it was until it can be drawn whole.
  if (holdView()) return;
  renderTabs();
  renderPanel();
  // The strip is drawn before the centre: drawn again when the centre's
  // pane came or went with it (the filmstrip button, 2026-11-10: it came a
  // state late, 100 ms after the rest of a split tab).
  void renderCentre().then(() => { if (!$('tabs').hidden && tabsFilmable !== filmableNow()) renderTabs(); renderStrip(); film?.follow(paneOnScreen()); renderHint(); syncWindowBackground(); });
}

/**
 * macOS grows the window before the page is drawn into the new part (a
 * live resize), showing the window's own colour there for a frame: it is
 * set to the colour the page has at its right edge (the terminal's, the
 * panel's, a page's), so the edge does not blink another colour.
 */
let windowBg = '';
function syncWindowBackground(): void {
  const el = document.elementFromPoint(window.innerWidth - 40, Math.round(window.innerHeight / 2));
  let c = '';
  for (let x: Element | null = el; x && !c; x = x.parentElement) {
    const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(getComputedStyle(x).backgroundColor);
    if (m && (m[4] === undefined || Number(m[4]) > 0.5)) c = '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  }
  if (!c) { const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor); if (m) c = '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join(''); }
  if (!c || c === windowBg) return;
  windowBg = c;
  try { api().windowBackground(c); } catch { /* an older preload */ }
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
  // window.json is read entry by entry: one that is not what this version
  // writes (a null pin, a number, a hand edit) is left out, never thrown on.
  const str = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
  const pinned = [...new Set((Array.isArray(saved.pinned) ? saved.pinned as unknown[] : old ? old.filter((t) => t && t.kind === 'session').map((t) => t.key) : []).filter(str))]
    .map((key): SessionTab => ({ id: pinId(key), kind: 'session', key }));
  const tabs: Tab[] = [...shells, ...pinned];
  // The order the person left them in, where it still holds.
  const order = (Array.isArray(saved.order) ? saved.order as unknown[] : old ? old.filter((t) => t && typeof t === 'object').map((t) => (t.kind === 'shell' ? shellId(t.pane || '') : pinId(t.key || ''))) : []).filter(str);
  const rank = (t: Tab) => { const i = order.indexOf(t.id); return i < 0 ? order.length + tabs.indexOf(t) : i; };
  S.tabs = tabs.sort((a, b) => rank(a) - rank(b));
  // The splits, where both panes are still there.
  for (const sp of Array.isArray(saved.splits) ? saved.splits as (SplitInfo & { host: string })[] : []) {
    if (!sp || typeof sp !== 'object' || !str(sp.host) || !str(sp.guest)) continue;
    const host = S.tabs.find((x) => x.id === sp.host);
    const g = S.tabs.find((x) => x.id === sp.guest);
    if (host && g && g.kind === 'shell') { linkSplit(host, g, sp.side, sp.focus === 1 ? 1 : 0); if (host.split) { host.split.size = Number(sp.size) || 50; host.split.zoom = !!sp.zoom; } }
  }
  const activeId = typeof saved.active === 'string' ? saved.active : null;
  const active = activeId ? S.tabs.find((t) => t.id === activeId) : null;
  S.view = active ? { kind: 'tab', id: active.id } : S.tabs[0] ? { kind: 'tab', id: S.tabs[0].id } : { kind: 'none' };
  S.restored = true;
  if (old) save();
}

/**
 * A terminal view and its marks, wired as every view is: the window's keys,
 * links, dropped files, the text size, and what it shows. termA shows a
 * tab's own pane, termB its split's (a second xterm.js only while a split
 * shows).
 */
/** How long after a new size what a hidden terminal's program prints is its redraw (ms). */
const SIZED_QUIET = 1000;
function makeView(el: HTMLElement): [TerminalView, TerminalMarks] {
  const term = new TerminalView(el);
  let marks: TerminalMarks;
  term.isAppKey = (e) => {
    // The app's shortcuts reach the menu instead of the shell.
    if (isMac()) return e.metaKey;
    // Ctrl+, (Settings) too, past xterm.js.
    return (e.ctrlKey && e.shiftKey && /^[tTwWnNbBcCvVaAfFgGdD]$/.test(e.key)) || (e.ctrlKey && e.key === ',');
  };
  // The Cmd keys of macOS's terminals xterm.js does not do (terminal.ts).
  term.mac = isMac();
  // Cmd+click on a link (OSC 8 or a URL in the text): the browser, or the file.
  term.onOpenLink = (uri) => api().openExternal(uri);
  // A file dropped on the terminal pastes its path.
  term.pathOf = (f) => { try { return api().pathForFile(f) || ''; } catch { return ''; } };
  // The settings (docs/SETTINGS.md), as they are now.
  if (termSettings) term.applySettings(termSettings);
  // A bell: the pane flashes (visual), and the main process plays the sound
  // and bounces the Dock as the settings say.
  // Hidden in a pool, the tab's bell instead (paneRang).
  term.onBell = () => {
    if (!inFront(term)) { if (term.attached) paneRang(term.attached.pane); return; }
    if (termSettings?.bell === 'visual') flashBell(el);
    api().settings.bell();
  };
  // Copy on select (a setting).
  term.onCopy = (text) => api().copyText(text);
  // A right click: the system's own menu.
  term.onContextMenu = (link) => { if (term === termB) focusSplit(1); else if (tabOfView()?.split) focusSplit(0); void contextMenu(term, link); };
  term.onFindResults = (i, n) => { find.index = i; find.count = n; renderFind(); };
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
  marks = new TerminalMarks(term.term, {
    who: (r) => (byPerson(r.source) ? null : (() => { const w = sourceOf(r.source); return { name: w.who, cls: w.cls }; })()),
    note: (r) => { const a = term.attached; const l = a ? letBy(a.pane, r) : null; return l ? (l.once ? 'you let it once' : 'you let it for its session') : null; },
    time: (iso) => timeOf(iso, now()),
  });
  term.onShown = (a) => { marks.reset(); if (a) marks.show(store.inputsOf(a.pane)); renderStrip(); };
  // Hidden in a pool, what the program prints is the tab's quiet dot
  // (panePrinted), except a snapshot and its redraw just after a new size.
  term.onWritten = (a, mark, snapshot) => {
    marks.written(mark, snapshot);
    if (!snapshot && !inFront(term) && performance.now() - term.sizedAt > SIZED_QUIET) panePrinted(S.tabs.find((x): x is ShellTab => x.kind === 'shell' && x.pane === a.pane));
  };

  // A click in a split's pane gives it the keyboard.
  el.addEventListener('pointerdown', () => { const host = tabOfView(); if (host && host.split) focusSplit(term === termB ? 1 : 0); }, true);
  return [term, marks];
}

function viewB(): TerminalView {
  if (!termB) { [termB, marksB] = makeView($('term2')); pools[1].push({ view: termB, marks: marksB, el: $('term2'), used: Date.now() }); }
  return termB;
}

// ---- the terminal settings (docs/SETTINGS.md; the Settings window writes them)
let termSettings: TerminalSettings | null = null;
function applyTerminalSettings(snap: SettingsSnapshot): void {
  termSettings = snap.terminal;
  for (const v of allViews()) v.applySettings(termSettings);
  // What draws beside the terminals (a split's headers, Find, the marks)
  // takes the terminal theme's colours.
  const th = termSettings.xterm.theme;
  const root = document.documentElement.style;
  if (th.background) root.setProperty('--tbg', th.background);
  if (th.foreground) root.setProperty('--tfg', th.foreground);
  document.body.classList.toggle('term-light', snap.terminal.appearance === 'light');
  for (const v of allViews()) if (v.attached) void paneScrollback(v.attached.client, v.attached.pane);
  // Find's tints follow the terminal's theme: drawn again in the new one.
  if (find.open && find.query) { termA.clearFind(); termB?.clearFind(); runFind(1, true); }
}

/**
 * The daemon keeps as many lines of a pane as the Scrollback setting says,
 * so a snapshot (a tab shown again, a relaunch) brings them all back. Set
 * on each pane on screen; a daemon too old for it keeps its own.
 */
async function paneScrollback(client: RavenryClient, pane: string): Promise<void> {
  const want = termSettings?.xterm.scrollback;
  if (!want || store.get(pane)?.pane.scrollback === want) return;
  try { await client.request('pane.update', { pane, scrollback: want }); } catch { /* an older daemon */ }
}

/** The visual bell: the pane flashes amber for about 150 ms. */
function flashBell(el: HTMLElement): void {
  const box = el.closest('.pbox') as HTMLElement | null;
  if (!box) return;
  box.classList.remove('bell');
  void box.offsetWidth;
  box.classList.add('bell');
  setTimeout(() => box.classList.remove('bell'), 180);
}

/** The pane's folder: its shell tab's, else what the daemon says of the pane. */
function paneCwd(pane: string | null | undefined): string | null {
  if (!pane) return null;
  const t = S.tabs.find((x): x is ShellTab => x.kind === 'shell' && x.pane === pane);
  return (t && t.cwd) || store.get(pane)?.pane.cwd || null;
}

/** The terminal's right-click menu (main: term:menu), and what its pick does. */
async function contextMenu(v: TerminalView, link: string | null): Promise<void> {
  const a = v.attached;
  const cwd = paneCwd(a?.pane);
  const sel = v.selection;
  const pick = await api().termMenu({ selection: !!sel, link, cwd, split: !!tabOfView()?.split });
  switch (pick) {
    case 'open-link': if (link) api().openExternal(link); break;
    case 'copy-link': if (link) api().copyText(link); break;
    case 'copy': if (sel) api().copyText(sel); break;
    case 'paste': v.onKeyAct('paste'); break;
    case 'select-all': v.onKeyAct('select-all'); break;
    case 'copy-path': if (cwd) api().copyText(cwd); break;
    case 'find': openFind(); break;
    case 'clear': v.onKeyAct('clear'); break;
    case 'split-right': void splitNew('right'); break;
    case 'split-down': void splitNew('down'); break;
  }
}

// ---- Find (Cmd+F): floats over the pane's top right (the picture, F1)
const find = { open: false, query: '', caseSensitive: false, regex: false, index: 0, count: 0 };
let findInput: HTMLInputElement | null = null;
function openFind(): void {
  const sel = term.selection;
  if (sel && !sel.includes('\n')) find.query = sel;
  find.open = true;
  renderFind();
  findInput?.focus();
  findInput?.select();
  if (find.query) runFind(1, false);
}
function closeFind(): void {
  find.open = false;
  termA.clearFind();
  termB?.clearFind();
  renderFind();
  term.focus();
}
function runFind(dir: 1 | -1, incremental: boolean): void {
  if (!find.query) { term.clearFind(); return; }
  term.find(find.query, { caseSensitive: find.caseSensitive, regex: find.regex }, dir, incremental);
}
let findN: HTMLElement | null = null;
let findCase: HTMLElement | null = null;
let findRe: HTMLElement | null = null;
/** Drawn once, then only its count and toggles change (the input keeps the keyboard). */
function renderFind(): void {
  const bar = $('findbar');
  bar.hidden = !find.open;
  if (!find.open) return;
  if (!findInput) {
    findInput = h('input', { type: 'text', placeholder: 'Find', spellcheck: 'false', 'aria-label': 'Find in the pane',
      on: {
        input: () => { find.query = findInput!.value; runFind(1, true); },
        keydown: (e: Event) => {
          const k = e as KeyboardEvent;
          if (k.key === 'Escape') { k.preventDefault(); closeFind(); }
          else if (k.key === 'Enter') { k.preventDefault(); runFind(k.shiftKey ? -1 : 1, false); }
        },
      } }) as HTMLInputElement;
    // An option changed: the matches counted again from scratch.
    const toggle = (label: string, title: string, flip: () => void) => h('button.fb-t', { title, 'aria-pressed': 'false', on: { click: () => { flip(); term.clearFind(); runFind(1, false); renderFind(); findInput?.focus(); } } }, label);
    findN = h('span.fb-n');
    findCase = toggle('Aa', 'Match case', () => { find.caseSensitive = !find.caseSensitive; });
    findRe = toggle('.*', 'Regular expression', () => { find.regex = !find.regex; });
    replace(bar,
      h('span.fb-i', svg(I.SEARCH)), findInput, findN,
      h('button.fb-b', { title: `Previous (${isMac() ? '⌘⇧G' : 'Shift+Enter'})`, 'aria-label': 'Previous', on: { click: () => runFind(-1, false) } }, svg(I.UP)),
      h('button.fb-b', { title: `Next (${isMac() ? '⌘G' : 'Enter'})`, 'aria-label': 'Next', on: { click: () => runFind(1, false) } }, svg(I.DOWN)),
      h('span.fb-sep'), findCase, findRe, h('span.fb-sep'),
      h('button.fb-b', { title: 'Close (Esc)', 'aria-label': 'Close Find', on: { click: () => closeFind() } }, svg(I.CLOSE)));
  }
  if (findInput.value !== find.query) findInput.value = find.query;
  findN!.textContent = find.query ? (find.count ? `${find.index} of ${find.count}` : 'No results') : '';
  for (const [el, on] of [[findCase!, find.caseSensitive], [findRe!, find.regex]] as const) { el.classList.toggle('on', on); el.setAttribute('aria-pressed', on ? 'true' : 'false'); }
}

// ---- closing a busy shell (the picture, F3): asked first, as the settings say
async function askClose(t: Tab): Promise<void> {
  if (t.kind !== 'shell' || termSettings?.confirmCloseBusy === false) { void closeTab(t.id); return; }
  let busy: { cmd: string; shell: string } | null = null;
  try {
    const c = await daemons.get(t.socket);
    // Busy, as the daemon says it (pane.process `busy`); an older daemon's
    // answer has none: the terminal's foreground is not the pane's first process (the shell).
    const [r, list] = await Promise.all([
      c.request('pane.process', { pane: t.pane }) as Promise<{ foreground?: { pid: number; argv?: string[] }; busy?: boolean }>,
      c.request('pane.list', {}) as Promise<{ panes: { id: string; pid?: number }[] }>,
    ]);
    const fg = r.foreground;
    const first = list.panes.find((x) => x.id === t.pane)?.pid;
    if (fg && (typeof r.busy === 'boolean' ? r.busy : !!first && fg.pid !== first)) {
      const argv = (fg.argv || []).slice();
      if (argv[0]) argv[0] = argv[0].split('/').pop() || argv[0];
      busy = { cmd: argv.join(' ') || 'a program', shell: ((t.command || [])[0] || 'The shell').split('/').pop()!.replace(/^-/, '') };
    }
  } catch { busy = null; }
  if (!busy) { void closeTab(t.id); return; }
  const what = t.host ? 'pane' : 'tab';
  const box = $('closesheet');
  let dont = false;
  const done = (close: boolean) => {
    box.hidden = true;
    replace(box);
    document.removeEventListener('keydown', onKey, true);
    if (close) { if (dont) void api().settings.set({ confirmCloseBusy: false }); void closeTab(t.id); } else term.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); done(false); }
    else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement && e.target.classList.contains('danger'))) { e.preventDefault(); done(false); }
  };
  document.addEventListener('keydown', onKey, true);
  const cancel = h('button.btn', { on: { click: () => done(false) } }, 'Cancel');
  replace(box, h('div.cs', { role: 'alertdialog', 'aria-modal': 'true', 'aria-label': `Close this ${what}?` },
    h('div.cs-b', h('span.cs-i', svg(I.WARN)), h('div',
      h('div.cs-t', `Close this ${what}?`),
      h('p', `${busy.shell} is running `, h('code', busy.cmd), '. Close it anyway?'),
      h('p.t3', 'Closing ends it and everything it started.'))),
    h('div.cs-f',
      h('label.cs-d', h('input', { type: 'checkbox', on: { change: (e: Event) => { dont = (e.target as HTMLInputElement).checked; } } }), "Don't ask again"),
      h('span.sp'),
      cancel,
      h('button.btn.danger', { on: { click: () => done(true) } }, 'Close'))));
  box.hidden = false;
  cancel.focus();
}

async function boot(): Promise<void> {
  S.config = await api().config();
  document.body.classList.toggle('mac', isMac());
  daemons = new Daemons(onDaemonEvent, onDaemonLost, onDaemonReady);
  store.useClients((s) => daemons.get(s));
  // The terminal settings first, so the terminals start with them.
  try { applyTerminalSettings(await api().settings.get()); } catch { /* the defaults */ }
  api().settings.onChange((snap) => applyTerminalSettings(snap));
  // A task over 100 ms says in app.log what ran in it (terminal.ts).
  watchLongTasks((line) => api().log(line));
  [termA, marksA] = makeView($('term'));
  pools[0].push({ view: termA, marks: marksA, el: $('term'), used: Date.now() });
  // A tab dragged onto an edge of the pane in front: a split.
  const sp = $('split');
  sp.addEventListener('dragover', (e) => splitDragOver(e));
  sp.addEventListener('dragleave', (e) => { if (!sp.contains(e.relatedTarget as Node | null)) dropZone(null); });
  sp.addEventListener('drop', (e) => splitDrop(e));
  term = termA;
  marks = marksA;
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
      // Its main session, else its own page (the project view): never the board.
      if (!p) return false;
      pickProject(p, 'page');
      return true;
    },
    lastProject: () => lastSessionProject || (viewSessionKey() || '').split('/')[0] || null,
    openPlan: (project, title) => setView({ kind: 'plan', project, title, back: backFrom() }),
    openIdea: (id) => setView({ kind: 'idea', id, back: backFrom() }),
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
  inapp = new InApp($('inapp'), {
    hub: () => S.hub,
    hubUrl: () => S.config?.hubUrl || '',
    call: (method, p, body) => api().hubCall(method, p, body),
    go: (v) => setView(v as View),
    back: (v) => setView((v.back as View) || { kind: 'none' }),
    openIdeas: () => openPage('ideas'),
    openBrief: (project) => setView({ kind: 'brief', key: `project:${project}`, project }),
    showSession: (project) => { const p = (S.hub?.projects || []).find((x) => x.id === project); const s = p && p.sessions.find((x) => !x.handed); if (!p || !s) return false; pickSession(`${p.id}/${s.surfaceId}`, 'plan page'); return true; },
    pairPhone: () => { const b = document.querySelector('#side .foot [aria-label="Open on your phone"]') as HTMLElement | null; if (b && !phoneCard.open) b.click(); },
    notificationSettings: () => api().openNotificationSettings(),
    toast: (text, error) => toast(text, undefined, error ? { at: here(), error: true } : undefined),
    onScreen: () => (IN_KINDS.has(S.view.kind) ? (S.view as InView) : null),
    now,
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
  api().onHubStatus((st) => { const was = !!S.hubStatus?.reachable; S.hubStatus = st as HubStatus; if (!was && (st as HubStatus).reachable) { void loadSetupLines(); void onbSync(); } setBoardLive(!!(st as HubStatus).reachable); if (!(st as HubStatus).reachable) S.hub = S.hub || null; render(); if (firstRun()) void loadStart(); });
  window.addEventListener('resize', () => { if (wide() && S.overlay && !S.panelKey) S.overlay = false; renderPanel(); renderTabs(); renderHint(); });
  // The strip's room changes when the panel shows or hides.
  new ResizeObserver(() => fitTabs($('tabs'))).observe($('tabs'));
  document.addEventListener('pointerover', (e) => prepareFrom(e.target), true);
  // A click on one of Ravenry's Mac notifications: the session it was about, else its project.
  api().onNotifyOpen((n) => {
    if (!n || !n.projectId) return;
    const p = (S.hub?.projects || []).find((x) => x.id === n.projectId);
    if (!p) return;
    const s = n.surfaceId ? p.sessions.find((x) => x.surfaceId === n.surfaceId) : null;
    if (s) pickSession(`${p.id}/${s.surfaceId}`, 'notification'); else pickProject(p, 'notification');
  });
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
  const got: unknown = await api().storeGet().catch(() => ({}));
  const saved = (got && typeof got === 'object' && !Array.isArray(got) ? got : {}) as Record<string, unknown>;
  S.panelPref = saved.panelPref === 'closed' || saved.panelPref === 'open' ? saved.panelPref : null;
  // The onboarding marks the board does not have yet (all of them, the first time after 0.1.23).
  onbLocal = onb.fromStore(saved);
  onbTake(onb.union(onbNow(), onbLocal));
  api().skills.onChange((rows) => takeSetupLines(rows as SkillRow[]));
  void loadSetupLines();
  const hs = await api().hubState();
  S.hub = (hs.state as HubState) || null;
  S.hubStatus = hs.status;
  // The board's onboarding marks before anything draws a hint (a slow board does not hold the window up).
  await Promise.race([onbSync(), new Promise((r) => setTimeout(r, 1500))]);
  if (S.hub) { S.cps.fromHub(S.hub.checkpoints as HubCheckpoint[] | undefined); pages.update((S.hub as { pages?: NavRow[] }).pages); }
  // A window opened with Cmd+N starts with a shell of its own; the first keeps the tabs.
  if (S.config?.primary !== false) {
    // Whatever window.json holds, the launch goes on: at worst with no tab back.
    await restoreTabs(saved).catch((e) => { api().log(`window: launch: the tabs in window.json could not come back: ${(e as Error).message}`); S.tabs = []; S.view = { kind: 'none' }; S.restored = true; });
  }
  else { thisWindow = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; S.restored = true; }
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
    S, term: () => term, views: () => [termA, termB], hintRegion: () => (hintRegion ? { left: hintRegion.left, top: hintRegion.top, right: hintRegion.right, bottom: hintRegion.bottom } : null), newShell, setView, onCommand, pickSession, render, ready: true, pages: () => pages, openPage, machines: () => machinesView,
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
