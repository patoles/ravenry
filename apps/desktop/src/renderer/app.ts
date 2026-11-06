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

import '@xterm/xterm/css/xterm.css';
import './app.css';
import type { AgentStatus, Checkpoint, DaemonEvent, Pane, RavenryClient } from '@ravenry/client';
import { api } from './api.ts';
import type { AppConfig, AssistantInfo, FolderPick, HubStatus } from './api.ts';
import { cardFor, cardKey, clearHiddenSecrets, focusCard, NotPerson, onCardChange, pruneCards } from './cards.ts';
import type { CardCtx, Reply } from './cards.ts';
import { Checkpoints, daemonAnswer, hubAnswer, isOpen, markOf } from './checkpoints.ts';
import type { HubCheckpoint, Known } from './checkpoints.ts';
import { Daemons } from './daemons.ts';
import { h, replace, svg } from './dom.ts';
import * as I from './icons.ts';
import {
  ago, arrivals, assistantName, board, clock, findSession, isEmpty, machineOf, memoryLine, paneOf, sessionGroup, sessionKey, sessionOfPane, tokens,
} from './model.ts';
import type { Group, HubProject, HubSession, HubState, RowMark } from './model.ts';
import { TerminalView } from './terminal.ts';

// ---------------------------------------------------------------- state

/** The label that marks a pane as one of the app's plain shells (PROTOCOL.md section 3). */
const SHELL_LABEL = { 'ravenry.kind': 'shell' } as const;

interface ShellTab {
  id: string; kind: 'shell'; socket: string; pane: string;
  /** The assistant the first launch started in it (its `ravenry.agent` label). */
  agent?: string | null;
  title?: string; cwd?: string; command?: string[]; cols?: number; rows?: number; createdAt?: string;
  /** The agent running in it, from the daemon's status channel. */
  status?: AgentStatus | null;
  /** It printed while it was not on screen. */
  activity?: boolean;
}
interface SessionTab { id: string; kind: 'session'; key: string }
type Tab = ShellTab | SessionTab;
type View =
  | { kind: 'tab'; id: string }
  /** A session picked in the sidebar; `pane` until the hub lists a session just started. */
  | { kind: 'session'; key: string; pane?: string }
  /** A pane of no tab: the one an approved command ran in. */
  | { kind: 'pane'; socket: string; pane: string; name: string }
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
  start: { folders: [] as FolderPick[], root: null as string | null, folder: null as string | null, assistants: [] as AssistantInfo[], assistant: null as string | null, busy: false, error: null as string | null },
  /** The first-launch offer to set up the assistants' hooks. */
  hooks: { asked: false, offer: null as null | { files: string[]; names: string[] }, busy: false, error: null as string | null, checked: false },
};

const $ = (id: string) => document.getElementById(id)!;
let term: TerminalView;
let daemons: Daemons;

// ---------------------------------------------------------------- helpers

const isMac = () => S.config?.platform === 'darwin';
const shortcut = (k: string) => (isMac() ? `⌘${k}` : `Ctrl+Shift+${k}`);
const wide = () => window.innerWidth >= PANEL_FOLD_WIDTH;
const base = (p?: string) => (p ? p.replace(/\/+$/, '').split('/').pop() || p : '');
const now = () => Date.now();
const tilde = (p?: string) => {
  const home = S.config?.home;
  if (!p) return '~';
  return home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p;
};

function tabOfView(): Tab | null {
  const v = S.view;
  return v.kind === 'tab' ? S.tabs.find((t) => t.id === v.id) || null : null;
}

/** The session the middle shows: a pinned session's tab, a session picked in the sidebar, or the one a shell runs. */
function viewSessionKey(): string | null {
  const v = S.view;
  if (v.kind === 'session') return v.key || (v.pane ? sessionOfPane(S.hub, v.pane)?.key || null : null);
  const t = tabOfView();
  if (t && t.kind === 'shell') return sessionOfPane(S.hub, t.pane)?.key || null;
  return t && t.kind === 'session' ? t.key : null;
}

function firstRun(): boolean {
  if (S.tabs.length) return false;
  if (S.view.kind === 'session' || S.view.kind === 'pane') return false;
  if (!S.hubStatus) return false; // not known yet
  return !S.hubStatus.reachable || isEmpty(S.hub);
}

const shellId = (pane: string) => `s:${pane}`;
const pinId = (key: string) => `k:${key}`;

function save(): void {
  const t = tabOfView();
  api().storeSet({
    pinned: S.tabs.filter((x): x is SessionTab => x.kind === 'session').map((x) => x.key),
    order: S.tabs.map((x) => x.id),
    active: t ? t.id : null,
    panelPref: S.panelPref,
    shellsLabelled: true,
    tabs: undefined,
  });
}

let toastTimer: number | undefined;
function toast(text: string): void {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.hidden = true; }, 5000);
}

function shellLabel(t: ShellTab): { name: string; sub: string | null } {
  // The pane's title when its program set one, else the program's name;
  // then the folder it is in (~ for home).
  const agent = t.agent ? assistantName(t.agent) : null;
  const title = (t.title || '').trim();
  const prog = base((t.command || [])[0] || '') || 'Shell';
  const home = S.config?.home;
  const folder = t.cwd && home && t.cwd === home ? '~' : base(t.cwd);
  return { name: agent || title || prog, sub: folder || null };
}

function tabLabel(t: Tab): { name: string; sub: string | null; group: Group | null; machine: string | null } {
  if (t.kind === 'shell') {
    // A shell the board follows as a session (an assistant runs in it) reads as that session.
    const f = sessionOfPane(S.hub, t.pane);
    if (f) return { name: f.session.topic || f.project.name, sub: f.project.name, group: openCpOn(t.pane) ? 'you' : sessionGroup(f.session), machine: null };
    const l = shellLabel(t);
    const st = t.status?.state;
    const group: Group | null = openCpOn(t.pane) || st === 'needs_you' ? 'you' : st === 'working' ? 'work' : null;
    return { ...l, group, machine: null };
  }
  const f = findSession(S.hub, t.key);
  if (!f) return { name: 'Session', sub: null, group: 'idle', machine: null };
  return { name: f.session.topic || f.project.name, sub: f.project.name, group: hasOpenCp(f.project, f.session) ? 'you' : sessionGroup(f.session), machine: machineOf(f.project, f.session) };
}

const GROUP_VAR: Record<Group, string> = { you: 'var(--you)', work: 'var(--work)', wait: 'var(--wait)', idle: 'var(--idle)' };
const RING: Record<Group, string> = { you: I.RING_YOU, work: I.RING_WORK, wait: I.RING_WAIT, idle: I.RING_IDLE };
const MARK_ICON: Record<string, string> = { ask: I.ASK, approve: I.RUN, secret: I.KEY, other: I.ASK };

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
  for (const k of S.cps.open()) {
    const t = targetOf(k);
    if (t.startsWith('tab:') || t.startsWith('cp:') || out.has(t)) continue;
    out.set(t, { ...markOf(k.cp), since: k.cp.created_at });
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
  answered: () => {
    // Answered: a narrow window goes back to the terminal, and the keyboard
    // goes back to the terminal unless it is somewhere else on purpose.
    if (S.overlay) { S.overlay = false; S.panelKey = null; render(); term.focus(); return; }
    const a = document.activeElement;
    if (!a || a === document.body || a.closest('#panel')) term.focus();
  },
};

/** A checkpoint opened: the panel opens on it, over the terminal on a narrow window. */
function arrive(k: Known): void {
  if (firstRun()) return;
  const t = targetOf(k);
  const shown = panelTargetKey();
  if (shown === t && panelVisible()) return;
  S.panelKey = t;
  if (!panelVisible()) S.overlay = true;
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
    list = h('div.sl', h('div.empty-side', S.hubStatus && !S.hubStatus.reachable
      ? 'Your sessions show up here, the ones that need you on top, once the board is running.'
      : 'Your sessions show up here, the ones that need you on top.'));
  } else {
    list = h('div.sl', groups.map((g) => h(`section.grp.g-${g.group}`,
      h('div.grp-h', svg(RING[g.group]), h('span.t', g.title), h(`span.cnt.c-${g.group}`, String(g.count))),
      g.projects.map((pr) => {
        if (g.group === 'idle') {
          return h('button.idl', { on: { click: () => pickProject(pr.project) } },
            h('span.n', pr.project.name), machineTag(pr.machine), h('span.t3.num.when', pr.time));
        }
        return [
          h('div.pj', h('span.n', pr.project.name), machineTag(pr.machine), h('span.t3.num.when', pr.time)),
          pr.rows.map((r) => {
            const sel = viewSessionKey() === r.key || panelTargetKey() === r.key && panelVisible() && S.overlay;
            const pinned = S.tabs.some((t) => t.kind === 'session' && t.key === r.key);
            const second = r.mark
              ? h('div.ss-q.k', h('span.kd', svg(MARK_ICON[r.mark.kind])), h(`span.qt${r.mark.code ? '.code' : ''}`, r.mark.text))
              : r.line ? h('div.ss-q', r.line) : null;
            return h(`div.ss${sel ? '.sel' : ''}`, { role: 'button', tabindex: '0', 'data-key': r.key, on: { click: () => pickSession(r.key), keydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') pickSession(r.key); } } },
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

  const views = S.hub?.views || {};
  const plans = (S.hub?.projects || []).filter((p) => p.plan).length;
  const navRow = (label: string, count: string | null, hash: string) =>
    h('button.vrow', { on: { click: () => openBoard(hash) }, title: `Open ${label} on the board` }, svg(I.NAV[label]), label, count ? h('span.c.num', count) : null);
  const nav = h(`nav.nav${empty ? '.dim' : ''}`,
    navRow('Objectives', null, '#/objectives'),
    navRow('Plans', plans ? `${plans} running` : null, '#/projects'),
    navRow('Ideas', views.ideas ? String(views.ideas) : null, '#/ideas'),
    navRow('Rules', views.rules ? `${views.rules} new` : null, '#/rules'),
    navRow('Ship', views.ship ? String(views.ship) : null, '#/ship'));

  const mem = memoryLine(S.hub);
  const foot = h('div.foot',
    h('button.icon-btn', { title: 'Settings', 'aria-label': 'Settings', on: { click: () => openBoard('') } }, svg(I.SETTINGS)),
    empty ? null : h('button.icon-btn', { title: 'Open on your phone', 'aria-label': 'Open on your phone', on: { click: () => openBoard('') } }, svg(I.PHONE)),
    empty ? null : h(`button.icon-btn${counts.you ? '.alert' : ''}`, { title: 'Alerts', 'aria-label': 'Alerts', on: { click: () => openBoard('') } }, svg(I.BELL)),
    h('span.sp'),
    mem && !empty ? h('span.mem.num', `Claude ${mem}`) : null);

  const mix = !empty && total ? h('div.mix', (['you', 'work', 'wait', 'idle'] as Group[]).filter((g) => counts[g]).map((g) => h('span', { style: { flex: String(counts[g]), background: GROUP_VAR[g] } }))) : null;

  replace($('side'), h('div.side-top'), brand, mix, list, empty ? h('span.fill') : null, nav, foot);
}

function openBoard(hash: string): void {
  if (!S.config) return;
  api().openExternal(S.config.hubUrl + '/' + hash);
}

function pickProject(p: HubProject): void {
  const s = p.sessions.find((x) => x.surfaceId === p.primary) || p.sessions[0];
  if (s) pickSession(`${p.id}/${s.surfaceId}`);
}

function pickSession(key: string): void {
  // A session that runs in a pane a tab already shows: that tab.
  const f = findSession(S.hub, key);
  const pane = f ? paneOf(f.session) : null;
  const pinned = S.tabs.find((t) => (t.kind === 'session' && t.key === key) || (pane && t.kind === 'shell' && t.pane === pane));
  S.panelKey = null;
  // A session waiting at a checkpoint: its card gets the keyboard, never the
  // terminal (a pasted secret must not land in the open), and on a narrow
  // window the panel opens over the terminal.
  const k = f ? cpOfSession(f.project, f.session) : null;
  if (k && isOpen(k.cp)) {
    S.focusCp = k.cp.id;
    if (!wide()) { S.overlay = true; S.panelKey = key; }
  }
  setView(pinned ? { kind: 'tab', id: pinned.id } : { kind: 'session', key });
}

function togglePin(key: string): void {
  const i = S.tabs.findIndex((t) => t.kind === 'session' && t.key === key);
  if (i >= 0) {
    const t = S.tabs[i];
    S.tabs.splice(i, 1);
    if (S.view.kind === 'tab' && S.view.id === t.id) S.view = { kind: 'session', key };
  } else {
    const t: SessionTab = { id: pinId(key), kind: 'session', key };
    S.tabs.push(t);
    if (S.view.kind === 'session' && viewSessionKey() === key) S.view = { kind: 'tab', id: t.id };
  }
  save();
  render();
}

// ---------------------------------------------------------------- tabs

/** The open session (picked in the sidebar, not pinned) or a command's pane: shown first in the strip while it is open. */
function openTab(): HTMLElement | null {
  const v = S.view;
  let name = '', sub: string | null = null, group: Group = 'idle', machine: string | null = null;
  if (v.kind === 'session') {
    const key = viewSessionKey();
    const f = key ? findSession(S.hub, key) : null;
    if (f) { name = f.session.topic || f.project.name; sub = f.project.name; group = hasOpenCp(f.project, f.session) ? 'you' : sessionGroup(f.session); machine = machineOf(f.project, f.session); } else name = 'Starting…';
  } else if (v.kind === 'pane') {
    name = v.name;
    group = 'idle';
  } else return null;
  const close = () => { const t = S.tabs[0]; setView(t ? { kind: 'tab', id: t.id } : { kind: 'none' }); };
  return h('div.tab.on', { role: 'tab', 'aria-selected': 'true', title: name, on: { auxclick: (e: Event) => { if ((e as MouseEvent).button === 1) close(); } } },
    v.kind === 'pane' ? h('span.ti', svg(I.SHELL)) : h('span.sd', { style: { background: GROUP_VAR[group] } }),
    h('span.n', name), sub ? h('span.p', sub) : null, machineTag(machine),
    h('button.x', { title: 'Close', 'aria-label': 'Close', on: { click: (e: Event) => { e.stopPropagation(); close(); } } }, svg(I.CLOSE)));
}

function renderTabs(): void {
  const el = $('tabs');
  if (firstRun() || S.view.kind === 'start' && !S.tabs.length) { el.hidden = true; return; }
  el.hidden = false;
  const active = tabOfView();
  replace(el,
    openTab(),
    S.tabs.map((t, i) => {
      const l = tabLabel(t);
      const on = active && active.id === t.id;
      if (on && t.kind === 'shell') t.activity = false;
      return h(`div.tab${on ? '.on' : ''}`, { role: 'tab', 'aria-selected': on ? 'true' : 'false', title: i < 9 ? `${l.name} (${isMac() ? '⌘' : 'Alt+'}${i + 1})` : l.name, on: { click: () => setView({ kind: 'tab', id: t.id }), auxclick: (e: Event) => { if ((e as MouseEvent).button === 1) closeTab(t.id); } } },
        t.kind === 'shell' && !l.group ? h('span.ti', svg(I.SHELL)) : h('span.sd', { style: { background: GROUP_VAR[l.group || 'idle'] } }),
        h('span.n', l.name),
        l.sub ? h('span.p', l.sub) : null,
        machineTag(l.machine),
        t.kind === 'shell' && t.activity && !on ? h('span.act', { title: 'New output' }) : null,
        h('button.x', { title: t.kind === 'shell' ? `Close (${shortcut('W')})` : 'Unpin', 'aria-label': 'Close', on: { click: (e: Event) => { e.stopPropagation(); closeTab(t.id); } } }, svg(I.CLOSE)));
    }),
    h('button.tab.add', { title: `New shell (${shortcut('T')})`, 'aria-label': 'New shell', on: { click: () => void newShell() } }, svg(I.PLUS(12))),
    h('span.sp'),
    h(`button.icon-btn${panelVisible() ? '.on' : ''}`, { title: panelVisible() ? 'Hide the session panel' : 'Show the session panel', 'aria-label': 'Session panel', on: { click: () => togglePanel() } }, svg(I.PANEL)));
}

async function newShell(): Promise<void> {
  try {
    const { client, socket } = await daemons.forNew();
    const cur = tabOfView();
    const cwd = cur && cur.kind === 'shell' && cur.cwd ? cur.cwd : undefined;
    const { cols, rows } = term.term;
    const cmd = S.config?.newShell;
    const { pane } = await client.request('pane.new', { cols, rows, name: 'Shell', labels: { ...SHELL_LABEL }, ...(cmd ? { command: cmd } : {}), ...(cwd ? { cwd } : {}) });
    addShellTab(socket, pane, null, true);
  } catch (e) {
    toast(`Could not open a shell: ${(e as Error).message}`);
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

function applyPane(t: ShellTab, p: Pane): void {
  t.status = p.agent || null;
  t.title = p.title;
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
    if (next) S.view = { kind: 'tab', id: next.id };
    else if (t.kind === 'session') S.view = { kind: 'session', key: t.key };
    else S.view = { kind: 'none' };
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

function setView(v: View): void {
  S.view = v;
  save();
  render();
}

function show(id: 'term' | 'elsewhere' | 'start' | 'none'): void {
  for (const k of ['term', 'elsewhere', 'start', 'none']) ($(k) as HTMLElement).hidden = k !== id;
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
async function showPane(key: string, get: () => Promise<RavenryClient | null>, pane: string, gone: (e: Error) => void): Promise<void> {
  show('term');
  if (shownKey === key && term.attached) { focusPending(); return; }
  shownKey = key;
  try {
    const client = await get();
    if (!client) throw new Error('no running daemon holds its pane');
    if (shownKey !== key) return;
    await term.show({ client, pane });
  } catch (e) {
    if (shownKey !== key) return;
    gone(e as Error);
  }
  focusPending();
}

async function renderCentre(): Promise<void> {
  const v = S.view;
  if (firstRun() || v.kind === 'start') { term.hide(); shownKey = ''; show('start'); renderStart(); return; }
  if (v.kind === 'none') { term.hide(); shownKey = ''; show('none'); renderNone(); focusPending(); return; }
  if (v.kind === 'pane') {
    await showPane(`pane|${v.socket}|${v.pane}`, () => daemons.get(v.socket), v.pane, (e) => { toast(`That pane is gone: ${e.message}`); setView(S.tabs[0] ? { kind: 'tab', id: S.tabs[0].id } : { kind: 'none' }); });
    return;
  }
  const t = tabOfView();
  if (t && t.kind === 'shell') {
    await showPane(`${t.socket}|${t.pane}`, () => daemons.get(t.socket), t.pane, (e) => { toast(`That shell is gone: ${e.message}`); removeTab(t.id); });
    return;
  }
  const key = viewSessionKey();
  const f = key ? findSession(S.hub, key) : null;
  const pane = f ? paneOf(f.session) : v.kind === 'session' ? v.pane || null : null;
  if (pane && (!f || !machineOf(f.project, f.session))) {
    // A session the hub runs in a ravenryd pane here shows its pane.
    await showPane(`session|${pane}`, () => daemons.holding(pane), pane, (e) => toast(`Could not show that session: ${e.message}`));
    return;
  }
  term.hide();
  shownKey = '';
  show('elsewhere');
  renderElsewhere(f);
  focusPending();
}

function renderNone(): void {
  replace($('none'), h('div.none-card',
    h('p', 'No shell is open.'),
    h('div.row', h('button.btn.pri', { on: { click: () => void newShell() } }, 'New shell'), h('span.t3', shortcut('T')))));
}

function renderElsewhere(f: { project: HubProject; session: HubSession } | null): void {
  if (!f) { replace($('elsewhere'), h('div.none-card', h('p', 'That session has ended.'))); return; }
  const { project, session } = f;
  const m = machineOf(project, session);
  const where = m ? `a terminal on ${m}` : session.termName || 'another terminal';
  const screen = (session.screen || []).join('\n').replace(/\s+$/, '');
  replace($('elsewhere'),
    h('div.else-head',
      h('div', h('div.else-t', session.topic || project.name), h('div.t2', `Runs in ${where}${project.folderShort ? `, in ${project.folderShort}` : ''}. Ravenry follows it from there.`)),
      !m && session.terminal !== false && !session.cannot ? h('button.btn', { on: { click: () => void hubOpen(project, session) } }, `Open in ${where}`) : null),
    screen ? h('pre.else-screen', screen) : h('p.t3', 'Nothing on its screen yet.'));
}

async function hubOpen(p: HubProject, s: HubSession): Promise<void> {
  try { await api().hubPost('/api/open', { projectId: p.id, surfaceId: s.surfaceId }); } catch (e) { toast((e as Error).message); }
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
  try {
    await api().hubPost('/api/setup/hooks', { ravenryd: S.config!.hookBin });
    const names = hk.offer?.names || ['Claude Code'];
    hk.asked = true; hk.offer = null; api().storeSet({ hooksAsked: true });
    toast(`${names.join(' and ')} now ${names.length > 1 ? 'tell' : 'tells'} Ravenry when ${names.length > 1 ? 'they need' : 'it needs'} you. The old settings were backed up.`);
  } catch (e) {
    hk.error = `Could not set them up: ${(e as Error).message}`;
  } finally {
    hk.busy = false;
    renderStart();
  }
}

function openStart(): void {
  S.start.error = null;
  setView({ kind: 'start' });
  void loadStart();
}

function renderStart(): void {
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
          h('span.s', h(`i.${x.found && x.signedIn ? 'ok' : x.found ? 'warn' : 'no'}`), x.found ? (x.signedIn ? 'Found, signed in' : 'Found, not signed in yet') : 'Not on this Mac'))))
        : h('p.t2.small', 'Neither Claude Code nor Codex is installed here yet. Install one, then come back. A plain shell works meanwhile.')));

  const label = a && folderName ? `Start ${assistantName(a.kind)} in ${folderName}` : folderName ? `Open a shell in ${folderName}` : 'Open a shell';
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

  const card = h('div.fl-card', { on: { dragover: (e: Event) => e.preventDefault(), drop: (e: Event) => onDrop(e as DragEvent) } }, folderRow, asstRow, go);
  replace($('start'), h('div.fl',
    svg(I.APP_ICON),
    h('h2', first ? 'Start your first session' : 'Start a session'),
    h('p.lead', 'Pick a folder and an assistant. It opens in a real terminal here, and the list on the left keeps every session in order, the ones that need you first.'),
    card,
    st.error ? h('p.err', st.error) : null,
    hooksCard,
    h('div.fl-foot', 'Keeping cmux, iTerm2 or Rex? Ravenry still follows the sessions you run there.')));
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
      const r = await api().hubPost('/api/sessions/start', { folder: st.folder || S.config?.home, assistant: a.kind, cols, rows }) as { surfaceId?: string; pane?: string; projectId?: string | null };
      setView({ kind: 'session', key: r.projectId && r.surfaceId ? `${r.projectId}/${r.surfaceId}` : '', ...(r.pane ? { pane: r.pane } : {}) });
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
  if (firstRun() || S.view.kind === 'start') return false;
  if (S.overlay) return true;
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
  if (S.panelKey) return S.panelKey;
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
  const docked = vis && !S.overlay && wide();
  el.classList.toggle('overlay', vis && !docked);
  if (!vis) { clearHiddenSecrets(false); return; }
  const key = panelTargetKey();
  let head: HTMLElement;
  let body: (HTMLElement | null)[];
  if (key && key.startsWith('tab:')) {
    const t = S.tabs.find((x): x is ShellTab => x.kind === 'shell' && x.id === key.slice(4));
    [head, body] = t ? shellPanel(t) : [panelHead('Shell', null), []];
  } else if (key && key.startsWith('cp:')) {
    const k = S.cps.get(key.slice(3));
    [head, body] = k ? loosePanel(k) : [panelHead('Session', null), []];
  } else {
    const f = key ? findSession(S.hub, key) : null;
    if (f) [head, body] = sessionPanel(f.project, f.session, key!);
    else {
      const t = tabOfView();
      if (t && t.kind === 'shell') [head, body] = shellPanel(t);
      else [head, body] = [panelHead('Session', null), [h('p.t3.small', 'Pick a session on the left to see its context, hand-off and brief here.')]];
    }
  }
  patch(el, [head, panelBody]);
  patch(panelBody, body);
  clearHiddenSecrets(true);
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

  if (k) body.push(cardFor(k, cardCtx));
  // Over the terminal on a narrow window, a card keeps the panel short: it and the context.
  const lean = !!k && isOpen(k.cp) && S.overlay;
  // The card replaces the plain question box.
  if (!k && g === 'you') {
    const q = w.headline || w.question || w.line || '';
    const quick = (w.quick || []).slice(0, 6);
    body.push(h('div.sec.ask',
      q ? h('p.q', q) : null,
      w.dialog && w.dialog.length ? h('pre.dlg', w.dialog.join('\n')) : null,
      quick.length ? h('div.qa', quick.map((o) => h('button.btn.sm', { on: { click: () => void answer(p, s, o.label, o.choice) } }, o.label))) : null));
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
      h('div.kv', p.brief.goal ? [h('span', 'Goal'), h('span', p.brief.goal)] : null, p.brief.next ? [h('span', 'Next'), h('span', p.brief.next)] : null)));
  }

  const plan = p.plan;
  body.push(h('div.sec',
    h('div.sec-h', 'Plan', h('span.sp'), h('span.t3.light', plan ? (p.planGate ? 'At a gate' : 'Running') : 'None running')),
    plan ? h('p', plan.title || plan.name || 'A plan is running.') : h('p.t2.small', 'Hand work over as steps; it runs on its own and stops at your gates.'),
    h('button.btn.sm.self', { on: { click: () => openBoard(plan ? `#/plan/${p.id}` : `#${p.id}`) } }, plan ? 'Open the plan' : 'New plan')));

  return [head, body];
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
  return [
    panelHead(t.agent ? assistantName(t.agent) || 'Shell' : shellLabel(t).name, null),
    [
      stLine,
      k ? cardFor(k, cardCtx) : null,
      !k && st?.need?.message ? h('div.sec.ask', h('p.q', st.need.message)) : null,
      h('div.sec',
        h('div.kv',
          h('span', 'Folder'), h('span.mono', tilde(t.cwd)),
          h('span', 'Runs'), h('span.mono', (t.command || []).join(' ') || 'your login shell'),
          [h('span', 'Size'), h('span.num', `${term.term.cols} x ${term.term.rows}`)],
          started ? [h('span', 'Started'), h('span.num', started)] : null)),
      h('p.t3.small', 'Shells keep running when you close the window. Closing the tab ends the shell and everything it started.'),
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
  try {
    await api().hubPost('/api/send', { projectId: p.id, surfaceId: s.surfaceId, ...(choice == null ? { text: label } : { choice }) });
    toast(`Sent: ${label}`);
  } catch (e) { toast((e as Error).message); }
}

async function handOff(p: HubProject, s: HubSession): Promise<void> {
  try { await api().hubPost('/api/handoff', { projectId: p.id, surfaceId: s.surfaceId }); toast('It hands off after the current task.'); } catch (e) { toast((e as Error).message); }
}

// ---------------------------------------------------------------- events

function onHubState(next: HubState): void {
  const prev = S.hub;
  S.hub = next;
  // A session the start screen just started: the view follows it once listed.
  const v = S.view;
  if (v.kind === 'session' && v.pane && !findSession(next, v.key)) {
    const f = sessionOfPane(next, v.pane);
    if (f) S.view = { kind: 'session', key: f.key };
  }
  const { opened, gone } = S.cps.fromHub(next.checkpoints as HubCheckpoint[] | undefined);
  if (gone.length) void closedOnHub(gone);
  // A checkpoint or an approval arrived: the panel opens on it.
  const arrived = arrivals(prev, next);
  if (!firstRun()) {
    if (opened.length) { const k = S.cps.get(opened[opened.length - 1]); if (k) arrive(k); }
    else if (arrived.length) {
      const k = arrived[arrived.length - 1];
      if (viewSessionKey() !== k || !panelVisible()) {
        S.panelKey = k;
        if (!panelVisible()) S.overlay = true;
      }
    }
  }
  render();
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
      return;
    }
    case 'agent.report': {
      const t = e.pane ? shellTabOf(socket, e.pane.id) : undefined;
      // Its turn ended: the card of a checkpoint answered before it is done.
      if (e.pane?.agent && (e.pane.agent.state === 'idle' || e.pane.agent.state === 'ended')) S.cps.settle(e.pane.id, Date.parse(e.pane.agent.since || e.pane.agent.at || '') || now());
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
  if (term.attached && S.tabs.some((t) => t.kind === 'shell' && t.socket === socket)) { shownKey = ''; void renderCentre(); }
}

function onCommand(name: string, arg?: unknown): void {
  switch (name) {
    case 'new-shell': void newShell(); break;
    case 'new-session': openStart(); break;
    case 'close-tab': { const t = tabOfView(); if (t) void closeTab(t.id); break; }
    case 'next-tab': stepTab(Number(arg) || 1); break;
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
  document.body.classList.toggle('mac', isMac());
  document.body.classList.toggle('first', firstRun());
  renderSidebar();
  renderTabs();
  renderPanel();
  void renderCentre();
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
  term.onEnded = (a) => {
    const t = S.tabs.find((x): x is ShellTab => x.kind === 'shell' && x.pane === a.pane);
    if (t) { removeTab(t.id); void a.client.request('pane.close', { pane: a.pane }).catch(() => {}); }
  };
  daemons = new Daemons(onDaemonEvent, onDaemonLost, onDaemonReady);
  onCardChange(() => { renderPanel(); });
  api().onCommand((n, a) => onCommand(String(n), a));
  api().onHubState((s) => onHubState(s as HubState));
  api().onHubStatus((st) => { S.hubStatus = st as HubStatus; if (!(st as HubStatus).reachable) S.hub = S.hub || null; render(); if (firstRun()) void loadStart(); });
  window.addEventListener('resize', () => { if (wide() && S.overlay && !S.panelKey) S.overlay = false; renderPanel(); renderTabs(); });
  window.addEventListener('keydown', (e) => {
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
  if (S.hub) S.cps.fromHub(S.hub.checkpoints as HubCheckpoint[] | undefined);
  await restoreTabs(saved);
  // The daemon new panes go to is followed from the start, for its checkpoints.
  void daemons.forNew().catch(() => {});
  render();
  if (firstRun() || !S.tabs.length) void loadStart();
  // For tests and screenshots (tools/driver.cjs): the state and a few calls.
  (window as unknown as { __ravenry: unknown }).__ravenry = {
    S, term: () => term, newShell, setView, onCommand, pickSession, render, ready: true,
    text: () => { const b = term.term.buffer.active; const out: string[] = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) || ''); return out.join('\n'); },
  };
  document.body.dataset.ready = '1';
}

void boot().catch((e) => {
  document.body.dataset.ready = 'error';
  console.error(e);
  toast(`Ravenry could not start: ${(e as Error).message}`);
});
