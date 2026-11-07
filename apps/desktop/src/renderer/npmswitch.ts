// The switch from the npm board, as drawn (variant A): the offer takes the
// first-launch place, with the person's own sessions in the sidebar beside
// it, and says what was found on this Mac and what happens to each; then
// each step as it is done and what the app's hub shows; after Not now or
// the way back, a quiet bar at the top of the terminal sheet; going back
// asks once, in a sheet over the window. The main process decides what
// shows (main/npmswitch.ts) and does the work (hub/server/npmswitch.mjs).
// tools/npm-switch-test.mjs and tools/npm-switch-shots.mjs drive it through
// window.__ravenryNpm.

import { h, replace, svg } from './dom.ts';
import * as I from './icons.ts';

type Step = { id: string; [k: string]: unknown };
interface Detect {
  npm: boolean;
  board: { port: number; pid: number | null; version: string | null; own: boolean; again?: string | null } | null;
  login: { label: string }[];
  hooks: { claude: unknown[]; codex: unknown[] };
  copy: { version: string | null } | null;
  record: { state: string; port?: number; from?: { board?: { again?: string | null; command?: string } | null }; login?: { label: string }[] } | null;
}
interface NpmView {
  offer: 'none' | 'screen' | 'bar';
  phase: 'idle' | 'switching' | 'switched' | 'going-back' | 'back' | 'error';
  message: string | null;
  log: string[];
  steps: Step[];
  counts: Record<string, number> | null;
  confirmBack: boolean;
  result: { started?: boolean; again?: string | null; command?: string | null; port?: number } | null;
  detect: Detect | null;
  from: Detect | null;
  platform?: string;
}
interface NpmApi {
  npmState(): Promise<NpmView>;
  npmSwitch(): Promise<NpmView>;
  npmNotNow(): Promise<NpmView>;
  npmBack(): Promise<NpmView>;
  npmConfirmBack(on: boolean): Promise<NpmView>;
  onNpm(cb: (v: unknown) => void): () => void;
  copyText(text: string): void;
}

const api = (): NpmApi => (window as unknown as { ravenry: NpmApi }).ravenry;
let view: NpmView | null = null;
let dismissed = false;
let changed: () => void = () => {};
let bar: HTMLElement | null = null;
let sheet: HTMLElement | null = null;
// Whether the board the window reads answers now (the app's feed), so the
// bar and the pointer follow the npm board starting or stopping.
let live: boolean | null = null;

const ICON = {
  board: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="6" cy="6" r="4.5"/><circle cx="6" cy="6" r="1.5" fill="currentColor"/></svg>',
  hooks: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M2 6h8M6 2v8"/></svg>',
  login: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="1.5" y="2" width="9" height="8" rx="1.5"/><path d="M1.5 4.5h9"/></svg>',
  tick: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6.2l2.3 2.3 4.7-5"/></svg>',
  stop: '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5"/></svg>',
};

// "Claude Code and Codex", "Claude Code" or "Codex", and its verb.
function who(d: Detect): string {
  const c = d.hooks.claude.length > 0, x = d.hooks.codex.length > 0;
  return c && x ? 'Claude Code and Codex' : c ? 'Claude Code' : 'Codex';
}
const report = (d: Detect) => (who(d).includes(' and ') ? 'report' : 'reports');
const hasHooks = (d: Detect) => d.hooks.claude.length + d.hooks.codex.length > 0;
const menuWhere = (v: NpmView) => (v.platform === 'darwin' ? 'Ravenry menu' : 'Help menu');
const running = (d: Detect) => (d.board && !d.board.own ? d.board : null);
const version = (d: Detect) => (d.copy && d.copy.version ? ` ${d.copy.version}` : '');

/** The centre shows the switch: the offer, its steps, its end, or where it stopped. */
export function npmTakesCentre(): boolean {
  const v = view;
  if (!v) return false;
  if (v.phase === 'switching' || v.phase === 'error') return true;
  if (v.phase === 'switched') return !dismissed;
  return v.offer === 'screen' && v.phase === 'idle' && !!v.detect;
}

function row(icon: string, cls: string, title: string, sub: (string | Node)[] | null): HTMLElement {
  return h('div.sw-r', h(`span.sw-i${cls}`, icon ? svg(icon) : null), h('div.sw-c', h('span.h', title), sub ? h('span.s', ...sub) : null));
}

function offer(v: NpmView, d: Detect): HTMLElement {
  const b = running(d);
  const again = b && b.again;
  const atLogin = d.login.length > 0;
  const same = "It stops, and the app's hub starts on the same port.";
  const rows = [
    b ? row(ICON.board, '', `The npm board${version(d)} runs on :${b.port}`,
      atLogin ? [`Started at login. ${same}`] : again ? ['Started in a terminal with ', h('code', again), `. ${same}`] : [same])
      : row(ICON.board, '', `The npm board${version(d)} is not running`, ["The app's hub starts on its data and port."]),
    hasHooks(d) ? row(ICON.hooks, '', `${who(d)} ${report(d)} to it`, ['Their hooks point at the app instead. Your other hooks and settings stay.'])
      : row(ICON.hooks, '', 'No hooks report to it', ['The app offers its own when you start a session.']),
    atLogin ? row(ICON.login, '', 'It starts at login', ['That login start is turned off and kept, so going back turns it on again.'])
      : row(ICON.login, '', 'Nothing starts it at login', ['When something does, it is turned off and kept, so going back turns it on again.']),
  ];
  return h('div.fl.sw',
    svg(I.APP_ICON),
    h('h2', 'You already run Ravenry from npm'),
    h('p.lead', 'The app can take over from it on the same data. Your sessions, ideas, plans, rules and settings stay as they are.'),
    h('div.fl-card.sw-card', rows,
      h('div.sw-go',
        h('button.btn.pri.lg', { 'data-act': 'switch', on: { click: () => void api().npmSwitch() } }, 'Switch to the app'),
        h('button.btn', { 'data-act': 'not-now', on: { click: () => void api().npmNotNow() } }, 'Not now'),
        h('span.sp'),
        h('span.t3.small', 'A copy of everything is kept first'))),
    h('div.fl-foot', `You can go back any time: ${menuWhere(v)}, Go Back to the npm Board.`));
}

// The steps, each done, under way (or where it stopped), or still to come.
function steps(v: NpmView): HTMLElement[] {
  const d = v.from || v.detect;
  const got = new Map(v.steps.map((s) => [s.id, s]));
  const port = (got.get('hub')?.port as number) || (d && running(d)?.port) || v.detect?.record?.port || 4600;
  const want: { id: string; title: string; sub?: (s: Step) => (string | Node)[] }[] = [];
  if (d && d.login.length) want.push({ id: 'login', title: d.login.length > 1 ? 'Its login starts are off' : 'Its login start is off', sub: () => ['Kept, so going back turns it on again.'] });
  if (d && running(d)) want.push({ id: 'stopped', title: 'The npm board stopped' });
  want.push({ id: 'backup', title: 'A copy of your data is kept', sub: (s) => [h('code', `~/.ravenry/${String(s.dir || 'backups')}`), `, ${s.files} files`] });
  if (!d || hasHooks(d)) want.push({ id: 'hooks', title: d ? `${who(d)} ${report(d)} to the app` : 'Claude Code reports to the app', sub: () => ['Their settings files were backed up next to them.'] });
  const hub = got.get('hub');
  want.push({ id: 'hub', title: hub && hub.done ? `The app's hub runs on :${port}` : `Starting the app's hub on :${port}` });
  let next = true;
  return want.map((w) => {
    const s = got.get(w.id);
    const done = !!s && (w.id !== 'hub' || !!s.done);
    let cls = done ? '.ok' : '';
    let icon = done ? ICON.tick : '';
    if (!done && next) {
      next = false;
      if (v.phase === 'error') { cls = '.bad'; icon = ICON.stop; } else if (v.phase === 'switching') cls = '.run';
    }
    return row(icon, cls, w.title, done && w.sub ? w.sub(s!) : null);
  });
}

function switching(v: NpmView): HTMLElement {
  const err = v.phase === 'error';
  return h('div.fl.sw',
    h('h2', err ? 'The switch stopped' : 'Switching to the app'),
    h('p.lead', err ? (v.message || 'Something went wrong.') : 'A few seconds. Sessions keep running; anything they report meanwhile waits in the event files.'),
    h('div.fl-card.sw-card', steps(v),
      err ? h('div.sw-go',
        h('button.btn.pri', { 'data-act': 'switch', on: { click: () => void api().npmSwitch() } }, 'Try again'),
        h('span.sp'),
        h('span.t3.small', `Going back: ${menuWhere(v)}`)) : null));
}

function done(v: NpmView): HTMLElement {
  const c = v.counts;
  const tile = (n: number | undefined, one: string, many: string) => h('div', h('b.num', String(n ?? 0)), h('span', n === 1 ? one : many));
  return h('div.fl.sw',
    h('h2', 'Everything is here'),
    h('p.lead', 'The app runs your board now, at login too. The npm board is stopped and nothing starts it.'),
    h('div.fl-card.sw-card',
      c ? h('div.kept',
        tile(c.projects, 'project', 'projects'), tile(c.sessions, 'session', 'sessions'), tile(c.ideas, 'idea', 'ideas'),
        tile(c.plans, 'plan running', 'plans running'), tile(c.rules, 'rule', 'rules')) : null,
      h('div.sw-go',
        h('button.btn.pri.lg', { 'data-act': 'done', on: { click: () => { dismissed = true; changed(); } } }, 'Open the board'),
        h('span.sp'),
        h('span.t3.small', `Going back: ${menuWhere(v)}`))));
}

/** Draws the switch into the centre (the first-launch place). */
export function renderNpmCentre(el: HTMLElement): void {
  const v = view;
  if (!v) return;
  if (v.phase === 'switching' || v.phase === 'error') replace(el, switching(v));
  else if (v.phase === 'switched') replace(el, done(v));
  else if (v.detect) replace(el, offer(v, v.detect));
}

// The quiet bar, first in the terminal sheet, after Not now or the way back.
function renderBar(): void {
  const v = view;
  const centre = document.getElementById('centre');
  const show = !!v && v.offer === 'bar' && !v.confirmBack && v.phase !== 'switching' && v.phase !== 'going-back' && !!v.detect;
  if (!show || !centre) { if (bar) bar.hidden = true; return; }
  if (!bar) { bar = h('div.qbar', { id: 'npm-bar' }); centre.insertBefore(bar, centre.firstChild); }
  const d = v!.detect!;
  const back = v!.phase === 'back' || (!!d.record && d.record.state === 'back');
  const result = v!.phase === 'back' ? v!.result : null;
  const down = live === null ? !running(d) : !live;
  const again = (result && result.again) || (d.record && d.record.from && d.record.from.board && d.record.from.board.again) || null;
  bar.className = back ? 'qbar back' : 'qbar';
  const sw = h(back ? 'button.btn.sm' : 'button.btn.sm.pri', { 'data-act': 'switch', on: { click: () => void api().npmSwitch() } }, 'Switch to the app');
  if (back && down && again) {
    replace(bar, h('span', 'Back on the npm board. Start it as before:'), h('span.code1', again),
      h('button.btn.sm', { 'data-act': 'copy', on: { click: () => api().copyText(again) } }, 'Copy'), h('span.sp'), sw);
  } else if (back) {
    replace(bar, h('span', down ? 'Back on the npm board. Start it as you did before.' : 'Back on the npm board.'), h('span.sp'), sw);
  } else {
    replace(bar, h('span', 'Your npm board runs this data, so the app shows it and starts no hub of its own.'), h('span.sp'), sw);
  }
  bar.hidden = false;
}

// Going back, asked once in a sheet over the window.
function renderSheet(): void {
  const v = view;
  if (!v || (!v.confirmBack && v.phase !== 'going-back')) { if (sheet) sheet.hidden = true; return; }
  if (!sheet) { sheet = h('div.veil', { id: 'npm-switch' }); document.body.appendChild(sheet); }
  const rec = v.detect && v.detect.record;
  const atLogin = !!(rec && rec.login && rec.login.length);
  const busy = v.phase === 'going-back';
  replace(sheet, h('div.vsheet',
    h('div.hd', busy ? 'Going back to the npm board...' : 'Go back to the npm board?'),
    h('div.bd', "The app's hub stops and no longer starts at login.",
      h('ul', h('li', "Claude Code's and Codex's hooks go back to the npm board"), h('li', 'ideas made here are written back where it reads them'), h('li', 'your sessions, plans, rules and settings stay')),
      atLogin ? 'Its login start is turned on again, which starts it.' : 'You started the npm board yourself, so start it again the same way once this is done.'),
    h('div.ft',
      h('button.btn', { 'data-act': 'cancel', disabled: busy, on: { click: () => void api().npmConfirmBack(false) } }, 'Cancel'),
      h('button.btn.pri', { 'data-act': 'back', disabled: busy, on: { click: () => void api().npmBack() } }, busy ? 'Going back...' : 'Go back'))));
  sheet.hidden = false;
}

/** The person chose the npm board (Not now, or the way back): the app runs
 * no hub of its own, so what needs one points at the npm board instead.
 * Null otherwise. `again`: the command to start that board as before. */
export function npmChosen(): { again: string | null } | null {
  const v = view;
  if (!v || v.offer !== 'bar' || !v.detect || v.phase === 'switching' || v.phase === 'switched' || v.phase === 'going-back') return null;
  const d = v.detect;
  const again = (v.phase === 'back' && v.result && v.result.again) || (d.record && d.record.from && d.record.from.board && d.record.from.board.again) || (d.board && !d.board.own ? d.board.again || null : null);
  return { again: again || null };
}

/** The board the window reads answers, or not (app.ts, from its feed). */
export function setBoardLive(on: boolean): void {
  if (live === on) return;
  live = on;
  renderBar();
}

/**
 * In the first-launch place while the npm board keeps the data: where to go
 * instead of what needs the app's hub. `what` says what was asked for
 * ("Starting a session", "Machines"...), `url` is the npm board's page.
 */
export function renderNpmPointer(el: HTMLElement, what: string, o: { url: string; reachable: boolean; newShell: () => void; openUrl: (u: string) => void }): void {
  const c = npmChosen();
  const again = (c && c.again) || 'ravenry';
  const why = `${what} needs the app's own hub, which does not run while the npm board keeps your data.`;
  const sw = h('button.btn', { 'data-act': 'switch', on: { click: () => void api().npmSwitch() } }, 'Switch to the app');
  const card = o.reachable
    ? h('div.fl-card.sw-card',
      row(ICON.board, '', 'Do it on the npm board', ['It runs at ', h('code', o.url), ' and starts sessions in your terminal, as before.']),
      row(ICON.hooks, '', 'New shells work here', ['A plain shell in this window needs no hub.']),
      h('div.sw-go',
        h('button.btn.pri.lg', { 'data-act': 'open-board', on: { click: () => o.openUrl(o.url) } }, 'Open the npm board'),
        h('button.btn', { 'data-act': 'new-shell', on: { click: () => o.newShell() } }, 'New shell'),
        h('span.sp'), sw))
    : h('div.fl-card.sw-card',
      row(ICON.board, '', 'Start it as before', [h('code', again), ' in the terminal where you ran it. Its sessions show up here once it answers.']),
      row(ICON.hooks, '', 'New shells work here', ['A plain shell in this window needs no hub.']),
      h('div.sw-go',
        h('button.btn.pri.lg', { 'data-act': 'copy', on: { click: () => api().copyText(again) } }, 'Copy the command'),
        h('button.btn', { 'data-act': 'new-shell', on: { click: () => o.newShell() } }, 'New shell'),
        h('span.sp'), sw));
  replace(el, h('div.fl.sw.npm-ptr',
    svg(I.APP_ICON),
    h('h2', o.reachable ? 'Your board is the npm board' : 'Your npm board is not running'),
    h('p.lead', why),
    card,
    h('div.fl-foot', 'Switching to the app keeps every session, idea, plan, rule and setting, and can be undone.')));
}

function set(v: unknown): void {
  const next = v as NpmView;
  if (next && next.phase === 'switching') dismissed = false;
  view = next;
  renderBar();
  renderSheet();
  changed();
}

/** Starts following the switch's state; `onChange` redraws the window. */
export function initNpmSwitch(onChange: () => void): void {
  if (!api().npmState) return;
  changed = onChange;
  api().onNpm(set);
  void api().npmState().then(set);
  (window as unknown as { __ravenryNpm: unknown }).__ravenryNpm = {
    view: () => view,
    switch: () => api().npmSwitch(),
    notNow: () => api().npmNotNow(),
    back: () => api().npmBack(),
    confirmBack: (on: boolean) => api().npmConfirmBack(on),
    // Screenshots only: draw a given state (tools/npm-switch-shots.mjs).
    preview: (v: NpmView) => set(v),
  };
}
