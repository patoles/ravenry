// The window, layout A: the board in the sidebar (Needs you first), the
// terminal in the middle, the session panel on the right. The tab strip
// holds only plain shells and pinned sessions, so it never repeats the
// sidebar.

import '@xterm/xterm/css/xterm.css';
import './app.css';
import type { AgentStatus, DaemonEvent, Pane } from '@ravenry/client';
import { api } from './api.ts';
import type { AppConfig, AssistantInfo, FolderPick, HubStatus } from './api.ts';
import { Daemons } from './daemons.ts';
import { h, replace, svg } from './dom.ts';
import * as I from './icons.ts';
import {
  ago, arrivals, assistantName, board, clock, findSession, isEmpty, memoryLine, paneOf, sessionGroup, sessionOfPane, tokens,
} from './model.ts';
import type { Group, HubProject, HubSession, HubState } from './model.ts';
import { TerminalView } from './terminal.ts';

// ---------------------------------------------------------------- state

interface ShellTab {
  id: string; kind: 'shell'; socket: string; pane: string;
  /** The assistant the first-launch screen started in it. */
  agent?: string | null;
  title?: string; cwd?: string; command?: string[]; cols?: number; rows?: number; createdAt?: string;
  /** The agent running in it, from the daemon's status channel. */
  status?: AgentStatus | null;
}
interface SessionTab { id: string; kind: 'session'; key: string }
type Tab = ShellTab | SessionTab;
type View = { kind: 'tab'; id: string } | { kind: 'session'; key: string } | { kind: 'start' } | { kind: 'none' };

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
  /** The session the panel shows when it differs from the middle (a checkpoint that arrived). */
  panelKey: null as string | null,
  restored: false,
  daemonError: null as string | null,
  start: { folders: [] as FolderPick[], root: null as string | null, folder: null as string | null, assistants: [] as AssistantInfo[], assistant: null as string | null, busy: false, error: null as string | null },
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

/** The session the middle shows: a pinned session's tab or a session picked in the sidebar. */
function viewSessionKey(): string | null {
  const v = S.view;
  if (v.kind === 'session') return v.key;
  const t = tabOfView();
  if (t && t.kind === 'shell') return sessionOfPane(S.hub, t.pane)?.key || null;
  return t && t.kind === 'session' ? t.key : null;
}

function firstRun(): boolean {
  if (S.tabs.length) return false;
  if (!S.hubStatus) return false; // not known yet
  return !S.hubStatus.reachable || isEmpty(S.hub);
}

function save(): void {
  const tabs = S.tabs.map((t) => (t.kind === 'shell' ? { id: t.id, kind: t.kind, socket: t.socket, pane: t.pane, agent: t.agent || null } : t));
  const v = S.view;
  api().storeSet({ tabs, active: v.kind === 'tab' ? v.id : null, panelPref: S.panelPref });
}

let toastTimer: number | undefined;
function toast(text: string): void {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { el.hidden = true; }, 5000);
}

function tabLabel(t: Tab): { name: string; sub: string | null; group: Group | null; machine: string | null } {
  if (t.kind === 'shell') {
    // A shell the board follows as a session (an assistant runs in it) reads as that session.
    const f = sessionOfPane(S.hub, t.pane);
    if (f) return { name: f.session.topic || f.project.name, sub: f.project.name, group: sessionGroup(f.session), machine: null };
    // The pane's title when its program set one, else the program's name;
    // then the folder it started in (~ for home).
    const agent = t.agent ? assistantName(t.agent) : null;
    const title = (t.title || '').trim();
    const prog = base((t.command || [])[0] || '') || 'Shell';
    const home = S.config?.home;
    const folder = t.cwd && home && t.cwd === home ? '~' : base(t.cwd);
    const st = t.status?.state;
    const group: Group | null = st === 'needs_you' ? 'you' : st === 'working' ? 'work' : null;
    return { name: agent || title || prog, sub: folder || null, group, machine: null };
  }
  const f = findSession(S.hub, t.key);
  if (!f) return { name: 'Session', sub: null, group: 'idle', machine: null };
  return { name: f.session.topic || f.project.name, sub: f.project.name, group: sessionGroup(f.session), machine: f.session.machine || f.project.machine || null };
}

const GROUP_VAR: Record<Group, string> = { you: 'var(--you)', work: 'var(--work)', wait: 'var(--wait)', idle: 'var(--idle)' };
const RING: Record<Group, string> = { you: I.RING_YOU, work: I.RING_WORK, wait: I.RING_WAIT, idle: I.RING_IDLE };

function machineTag(name: string | null): HTMLElement | null {
  return name ? h('span.mt', { title: `Runs on ${name}` }, svg(I.MACHINE), name) : null;
}

// ---------------------------------------------------------------- sidebar

function renderSidebar(): void {
  const empty = firstRun();
  const groups = board(S.hub, now());
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
            const sel = viewSessionKey() === r.key;
            const pinned = S.tabs.some((t) => t.kind === 'session' && t.key === r.key);
            return h(`div.ss${sel ? '.sel' : ''}`, { role: 'button', tabindex: '0', on: { click: () => pickSession(r.key), keydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') pickSession(r.key); } } },
              h('div.ss-r',
                h('span.sd', { style: { background: GROUP_VAR[r.group] } }),
                h('span.n', r.name),
                r.assistant ? h('span.as-tag', r.assistant) : null,
                r.pct !== null ? h(`span.pc.num${r.pctWarn ? '.warn' : ''}`, `${r.pct}%`) : h('span.pc'),
                h(`button.pin${pinned ? '.on' : ''}`, { title: pinned ? 'Unpin from the tabs' : 'Pin to the tabs', 'aria-label': pinned ? 'Unpin' : 'Pin', on: { click: (e: Event) => { e.stopPropagation(); togglePin(r.key); } } }, svg(I.PIN))),
              r.line ? h('div.ss-q', r.line) : null);
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
  setView(pinned ? { kind: 'tab', id: pinned.id } : { kind: 'session', key });
}

function togglePin(key: string): void {
  const i = S.tabs.findIndex((t) => t.kind === 'session' && t.key === key);
  if (i >= 0) {
    const t = S.tabs[i];
    S.tabs.splice(i, 1);
    if (S.view.kind === 'tab' && S.view.id === t.id) S.view = { kind: 'session', key };
  } else {
    const t: SessionTab = { id: `t${Date.now().toString(36)}`, kind: 'session', key };
    S.tabs.push(t);
    if (S.view.kind === 'session' && S.view.key === key) S.view = { kind: 'tab', id: t.id };
  }
  save();
  render();
}

// ---------------------------------------------------------------- tabs

function renderTabs(): void {
  const el = $('tabs');
  if (firstRun() || S.view.kind === 'start' && !S.tabs.length) { el.hidden = true; return; }
  el.hidden = false;
  const active = tabOfView();
  replace(el,
    S.tabs.map((t, i) => {
      const l = tabLabel(t);
      const on = active && active.id === t.id;
      return h(`div.tab${on ? '.on' : ''}`, { role: 'tab', 'aria-selected': on ? 'true' : 'false', title: i < 9 ? `${l.name} (${isMac() ? '⌘' : 'Alt+'}${i + 1})` : l.name, on: { click: () => setView({ kind: 'tab', id: t.id }), auxclick: (e: Event) => { if ((e as MouseEvent).button === 1) closeTab(t.id); } } },
        t.kind === 'shell' && !l.group ? h('span.ti', svg(I.SHELL)) : h('span.sd', { style: { background: GROUP_VAR[l.group || 'idle'] } }),
        h('span.n', l.name),
        l.sub ? h('span.p', l.sub) : null,
        machineTag(l.machine),
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
    const { pane } = await client.request('pane.new', { cols, rows, name: 'Shell', ...(cmd ? { command: cmd } : {}), ...(cwd ? { cwd } : {}) });
    addShellTab(socket, pane, null);
  } catch (e) {
    toast(`Could not open a shell: ${(e as Error).message}`);
  }
}

function addShellTab(socket: string, pane: Pane, agent: string | null): ShellTab {
  const t: ShellTab = { id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, kind: 'shell', socket, pane: pane.id, agent };
  applyPane(t, pane);
  const cur = tabOfView();
  const at = cur ? S.tabs.indexOf(cur) + 1 : S.tabs.length;
  S.tabs.splice(at, 0, t);
  setView({ kind: 'tab', id: t.id });
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

let shownKey = '';
async function renderCentre(): Promise<void> {
  const v = S.view;
  if (firstRun() || v.kind === 'start') { term.hide(); shownKey = ''; show('start'); renderStart(); return; }
  if (v.kind === 'none') { term.hide(); shownKey = ''; show('none'); renderNone(); return; }
  const t = tabOfView();
  if (t && t.kind === 'shell') {
    show('term');
    const key = `${t.socket}|${t.pane}`;
    if (shownKey === key && term.attached) return;
    shownKey = key;
    try {
      const client = await daemons.get(t.socket);
      if (shownKey !== key) return;
      await term.show({ client, pane: t.pane });
    } catch (e) {
      if (shownKey !== key) return;
      toast(`That shell is gone: ${(e as Error).message}`);
      removeTab(t.id);
    }
    return;
  }
  const key = viewSessionKey();
  const f = key ? findSession(S.hub, key) : null;
  const pane = f ? paneOf(f.session) : null;
  if (f && pane) {
    // Seam for slice 2a: a session the hub runs in ravenryd shows its pane here.
    show('term');
    const k = `session|${pane}`;
    if (shownKey === k && term.attached) return;
    shownKey = k;
    try {
      const client = await daemons.holding(pane);
      if (!client) throw new Error('no running daemon holds its pane');
      if (shownKey === k) await term.show({ client, pane });
    } catch (e) { toast(`Could not show that session: ${(e as Error).message}`); }
    return;
  }
  term.hide();
  shownKey = '';
  show('elsewhere');
  renderElsewhere(f);
}

function renderNone(): void {
  replace($('none'), h('div.none-card',
    h('p', 'No shell is open.'),
    h('div.row', h('button.btn.pri', { on: { click: () => void newShell() } }, 'New shell'), h('span.t3', shortcut('T')))));
}

function renderElsewhere(f: { project: HubProject; session: HubSession } | null): void {
  if (!f) { replace($('elsewhere'), h('div.none-card', h('p', 'That session has ended.'))); return; }
  const { project, session } = f;
  const where = session.termName || 'another terminal';
  const screen = (session.screen || []).join('\n').replace(/\s+$/, '');
  replace($('elsewhere'),
    h('div.else-head',
      h('div', h('div.else-t', session.topic || project.name), h('div.t2', `Runs in ${where}${project.folderShort ? `, in ${project.folderShort}` : ''}. Ravenry follows it from there.`)),
      session.terminal !== false && !session.cannot ? h('button.btn', { on: { click: () => void hubOpen(project, session) } }, `Open in ${where}`) : null),
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
  if (firstRun() || S.view.kind === 'start') renderStart();
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

  const card = h('div.fl-card', { on: { dragover: (e: Event) => e.preventDefault(), drop: (e: Event) => onDrop(e as DragEvent) } }, folderRow, asstRow, go);
  replace($('start'), h('div.fl',
    svg(I.APP_ICON),
    h('h2', first ? 'Start your first session' : 'Start a session'),
    h('p.lead', 'Pick a folder and an assistant. It opens in a real terminal here, and the list on the left keeps every session in order, the ones that need you first.'),
    card,
    st.error ? h('p.err', st.error) : null,
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
    const { client, socket } = await daemons.forNew();
    const a = st.assistants.find((x) => x.kind === st.assistant && x.found) || null;
    const { cols, rows } = term.term;
    // Seam for slice 2a: once the hub starts sessions in ravenryd (with its
    // hooks), this asks the hub instead, and the session shows in the sidebar.
    const { pane } = await client.request('pane.new', {
      cols, rows,
      ...(st.folder ? { cwd: st.folder } : {}),
      ...(a ? { command: [a.path || a.kind], name: a.name } : { name: 'Shell', ...(S.config?.newShell ? { command: S.config.newShell } : {}) }),
    });
    addShellTab(socket, pane, a ? a.kind : null);
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

function renderPanel(): void {
  const el = $('panel');
  const vis = panelVisible();
  el.hidden = !vis;
  const docked = vis && !S.overlay && wide();
  el.classList.toggle('overlay', vis && !docked);
  if (!vis) return;
  const key = S.panelKey || viewSessionKey();
  const f = key ? findSession(S.hub, key) : null;
  if (f) { replace(el, ...sessionPanel(f.project, f.session, key!)); return; }
  const t = tabOfView();
  if (t && t.kind === 'shell') { replace(el, ...shellPanel(t)); return; }
  replace(el, panelHead('Session', null), h('div.p-b', h('p.t3.small', 'Pick a session on the left to see its context, hand-off and brief here.')));
}

function panelHead(name: string, tag: string | null, extra?: HTMLElement | null): HTMLElement {
  return h('div.p-h', h('span.n', name), tag ? h('span.as-tag', tag) : null, h('span.sp'), extra || null,
    h('button.icon-btn', { title: 'Hide', 'aria-label': 'Hide the panel', on: { click: () => togglePanel() } }, svg(I.CHEVRON)));
}

function statusLine(p: HubProject, s: HubSession): HTMLElement {
  const g = sessionGroup(s);
  const t = g === 'you' ? `Needs you since ${clock(s.since || p.since, now())}`
    : g === 'work' ? 'Working'
      : g === 'wait' ? (p.waitingOn ? `Waiting on ${p.waitingOn}` : 'Waiting on others')
        : `Idle${s.since ? ` for ${ago(s.since, now())}` : ''}`;
  return h(`div.st.c-${g}`, svg(RING[g]), t);
}

function sessionPanel(p: HubProject, s: HubSession, key: string): HTMLElement[] {
  const g = sessionGroup(s);
  const w = s.words || {};
  const threshold = S.hub?.settings?.handoffThreshold ?? 50;
  const pinned = S.tabs.some((t) => t.kind === 'session' && t.key === key);
  const out: HTMLElement[] = [panelHead(p.name, assistantName(s.assistant),
    h(`button.icon-btn${pinned ? '.on' : ''}`, { title: pinned ? 'Unpin from the tabs' : 'Pin to the tabs', 'aria-label': 'Pin', on: { click: () => togglePin(key) } }, svg(I.PIN)))];
  const body: (HTMLElement | null)[] = [statusLine(p, s)];

  if (g === 'you') {
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

  out.push(h('div.p-b', body));
  return out;
}

function shellPanel(t: ShellTab): HTMLElement[] {
  const started = t.createdAt ? clock(t.createdAt, now()) : null;
  // What the agent in it reported through the daemon's status channel.
  const st = t.status;
  const who = st ? assistantName(st.assistant) || 'The agent' : null;
  const needs = { permission: 'is asking for permission', question: 'has a question', auth: 'needs you to sign in', other: 'needs you' } as const;
  const stLine = !st ? null
    : st.state === 'needs_you' ? h('div.st.c-you', svg(RING.you), `${who} ${needs[st.need?.kind || 'other']}${st.since ? ` since ${clock(st.since, now())}` : ''}`)
      : st.state === 'working' ? h('div.st.c-work', svg(RING.work), `${who} is working`)
        : st.state === 'idle' ? h('div.st.c-idle', svg(RING.idle), `${who} is done with its turn`) : null;
  return [
    panelHead(t.agent ? assistantName(t.agent) || 'Shell' : 'Shell', null),
    h('div.p-b',
      stLine,
      st?.need?.message ? h('div.sec.ask', h('p.q', st.need.message)) : null,
      h('div.sec',
        h('div.kv',
          h('span', 'Folder'), h('span.mono', tilde(t.cwd)),
          h('span', 'Runs'), h('span.mono', (t.command || []).join(' ') || 'your login shell'),
          [h('span', 'Size'), h('span.num', `${term.term.cols} x ${term.term.rows}`)],
          started ? [h('span', 'Started'), h('span.num', started)] : null)),
      h('p.t3.small', 'Shells keep running when you close the window. Closing the tab ends the shell and everything it started.')),
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
  // A checkpoint or an approval arrived: the panel opens on it.
  const arrived = arrivals(prev, next);
  if (arrived.length && !firstRun()) {
    const k = arrived[arrived.length - 1];
    if (viewSessionKey() !== k || !panelVisible()) {
      S.panelKey = k;
      if (!panelVisible()) S.overlay = true;
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

async function refreshCwd(socket: string, t: ShellTab): Promise<void> {
  // The folder a shell is in now, so the tab follows cd.
  try {
    const c = await daemons.get(socket);
    if (!c.supports('pane.process')) return;
    const { foreground } = await c.request('pane.process', { pane: t.pane });
    if (foreground.cwd && foreground.cwd !== t.cwd) { t.cwd = foreground.cwd; renderTabs(); if (panelVisible()) renderPanel(); }
  } catch { /* exited */ }
}

function onDaemonEvent(socket: string, e: DaemonEvent): void {
  if (e.event === 'pane.focus') { focusPane(socket, e.pane.id); return; }
  if (e.event === 'pane.prompt') { const t = shellTabOf(socket, e.pane.id); if (t) void refreshCwd(socket, t); return; }
  if (e.event === 'agent.report') {
    const t = e.pane ? shellTabOf(socket, e.pane.id) : undefined;
    if (t && e.pane) { t.status = e.pane.agent || null; renderTabs(); if (panelVisible()) renderPanel(); }
    return;
  }
  if (e.event === 'pane.title' || e.event === 'pane.exited' || e.event === 'pane.closed') {
    const t = S.tabs.find((x): x is ShellTab => x.kind === 'shell' && x.socket === socket && x.pane === e.pane.id);
    if (!t) return;
    if (e.event === 'pane.title') { applyPane(t, e.pane); renderTabs(); if (panelVisible()) renderPanel(); return; }
    // The shell ended: its tab goes, as in any terminal.
    removeTab(t.id);
    if (e.event === 'pane.exited') void daemons.get(socket).then((c) => c.request('pane.close', { pane: e.pane.id })).catch(() => {});
  }
}

function onDaemonLost(socket: string): void {
  // The daemon went away (stopped, or replaced by an update that finished).
  // Its tabs reconnect when shown; if it is gone for good they close then.
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

// ---------------------------------------------------------------- render

function render(): void {
  document.body.classList.toggle('mac', isMac());
  document.body.classList.toggle('first', firstRun());
  renderSidebar();
  renderTabs();
  renderPanel();
  void renderCentre();
}

async function restoreTabs(saved: Record<string, unknown>): Promise<void> {
  const list = Array.isArray(saved.tabs) ? saved.tabs as Tab[] : [];
  const bySocket = new Map<string, ShellTab[]>();
  for (const t of list) if (t && t.kind === 'shell' && t.socket && t.pane) bySocket.set(t.socket, [...(bySocket.get(t.socket) || []), t]);
  const alive = new Set<string>();
  await Promise.all([...bySocket].map(async ([socket, tabs]) => {
    try {
      const c = await daemons.get(socket);
      const { panes } = await c.request('pane.list', { hidden: true });
      for (const t of tabs) {
        const p = panes.find((x) => x.id === t.pane);
        if (p && p.state === 'running') { applyPane(t, p); alive.add(t.id); }
      }
    } catch { /* that daemon is gone, and its panes with it */ }
  }));
  S.tabs = list.filter((t) => (t.kind === 'shell' ? alive.has(t.id) : !!t.key));
  const active = typeof saved.active === 'string' ? S.tabs.find((t) => t.id === saved.active) : null;
  S.view = active ? { kind: 'tab', id: active.id } : S.tabs[0] ? { kind: 'tab', id: S.tabs[0].id } : { kind: 'none' };
  S.restored = true;
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
  // A shell without shell integration sends no prompt marks: look at its
  // folder a moment after each Enter instead, so the tab follows cd.
  let cwdTimer: number | undefined;
  term.onEnter = (a) => {
    clearTimeout(cwdTimer);
    cwdTimer = window.setTimeout(() => {
      const t = S.tabs.find((x): x is ShellTab => x.kind === 'shell' && x.pane === a.pane);
      if (t) void refreshCwd(t.socket, t);
    }, 400);
  };
  daemons = new Daemons(onDaemonEvent, onDaemonLost);
  api().onCommand((n, a) => onCommand(String(n), a));
  api().onHubState((s) => onHubState(s as HubState));
  api().onHubStatus((st) => { S.hubStatus = st as HubStatus; if (!(st as HubStatus).reachable) S.hub = S.hub || null; render(); if (firstRun()) void loadStart(); });
  window.addEventListener('resize', () => { if (wide() && S.overlay && !S.panelKey) S.overlay = false; renderPanel(); renderTabs(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.overlay) { S.overlay = false; S.panelKey = null; render(); } });
  const saved = await api().storeGet();
  S.panelPref = saved.panelPref === 'closed' || saved.panelPref === 'open' ? saved.panelPref : null;
  const hs = await api().hubState();
  S.hub = (hs.state as HubState) || null;
  S.hubStatus = hs.status;
  await restoreTabs(saved);
  render();
  if (firstRun() || !S.tabs.length) void loadStart();
  // For tests and screenshots (tools/driver.cjs): the state and a few calls.
  (window as unknown as { __ravenry: unknown }).__ravenry = {
    S, term: () => term, newShell, setView, onCommand, ready: true,
    text: () => { const b = term.term.buffer.active; const out: string[] = []; for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) || ''); return out.join('\n'); },
  };
  document.body.dataset.ready = '1';
}

void boot().catch((e) => {
  document.body.dataset.ready = 'error';
  console.error(e);
  toast(`Ravenry could not start: ${(e as Error).message}`);
});
