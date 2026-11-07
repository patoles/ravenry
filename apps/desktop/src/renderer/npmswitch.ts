// The switch from the npm board, as a plain placeholder until its screen is
// drawn for real (the mock: docs of the switch in apps/desktop/README.md).
// The main process decides what shows (main/npmswitch.ts): the screen over
// the window, the quiet bar at its top, the steps while it switches, and
// the way back's question. tools/npm-switch-test.mjs drives it through
// window.__ravenryNpm.

import { h, replace } from './dom.ts';

interface NpmView {
  offer: 'none' | 'screen' | 'bar';
  phase: 'idle' | 'switching' | 'switched' | 'going-back' | 'back' | 'error';
  message: string | null;
  log: string[];
  confirmBack: boolean;
  result: { started?: boolean; command?: string | null; cwd?: string | null; port?: number } | null;
  detect: {
    npm: boolean;
    board: { port: number; pid: number | null; version: string | null; own: boolean } | null;
    login: { label: string }[];
    hooks: { claude: unknown[]; codex: unknown[] };
    copy: { version: string | null } | null;
    record: { state: string } | null;
  } | null;
}

interface NpmApi {
  npmState(): Promise<NpmView>;
  npmSwitch(): Promise<NpmView>;
  npmNotNow(): Promise<NpmView>;
  npmBack(): Promise<NpmView>;
  npmConfirmBack(on: boolean): Promise<NpmView>;
  onNpm(cb: (v: unknown) => void): () => void;
}

const api = (): NpmApi => (window as unknown as { ravenry: NpmApi }).ravenry;
let view: NpmView | null = null;
let el: HTMLElement;
let dismissed = false;

function what(d: NonNullable<NpmView['detect']>): string[] {
  const out: string[] = [];
  const b = d.board && !d.board.own ? d.board : null;
  out.push(b ? `The npm board ${d.copy?.version || ''} runs on :${b.port} (pid ${b.pid}).`.replace('  ', ' ') : `The npm board ${d.copy?.version || ''} is not running.`.replace('  ', ' '));
  if (d.login.length) out.push(`It starts at login (${d.login.map((l) => l.label).join(', ')}).`);
  const n = d.hooks.claude.length + d.hooks.codex.length;
  if (n) out.push(`Claude Code${d.hooks.codex.length ? ' and Codex' : ''} report to it through its hooks.`);
  return out;
}

function render(): void {
  const v = view;
  if (!v) { el.hidden = true; return; }
  const busy = v.phase === 'switching' || v.phase === 'going-back';
  const d = v.detect;
  let body: HTMLElement | null = null;
  if (v.confirmBack) {
    body = h('div.npmsw-card',
      h('h2', 'Go back to the npm board?'),
      h('p', "The app's hub stops. Your hooks and the login start go back to the npm board, and ideas made here are written back to ideas.json. Your sessions, plans, rules and settings stay where they are."),
      h('div.npmsw-btns',
        h('button.btn.pri', { 'data-act': 'back', on: { click: () => void api().npmBack() } }, 'Go back'),
        h('button.btn', { 'data-act': 'cancel', on: { click: () => void api().npmConfirmBack(false) } }, 'Cancel')));
  } else if (busy || v.phase === 'error' || (v.phase === 'switched' && !dismissed)) {
    const title = v.phase === 'switching' ? 'Switching to the app...' : v.phase === 'going-back' ? 'Going back to the npm board...' : v.phase === 'switched' ? 'Switched. Everything is here.' : 'The switch stopped';
    body = h('div.npmsw-card',
      h('h2', title),
      v.message ? h('p.npmsw-err', v.message) : null,
      h('ul.npmsw-log', v.log.slice(-8).map((l) => h('li', l))),
      !busy ? h('div.npmsw-btns',
        v.phase === 'error' ? h('button.btn.pri', { 'data-act': 'switch', on: { click: () => void api().npmSwitch() } }, 'Try again') : null,
        h('button.btn', { 'data-act': 'done', on: { click: () => { dismissed = true; render(); } } }, 'Done')) : null);
  } else if (v.offer === 'screen' && d) {
    body = h('div.npmsw-card',
      h('h2', 'Switch from the npm board'),
      h('ul.npmsw-what', what(d).map((l) => h('li', l))),
      h('p', 'The app runs its own hub on the same data and port. Switching stops the npm board, turns its login start off, and points the hooks at the app. Every session, idea, plan, rule and setting stays, and a copy of it all is kept first. You can go back from the app menu.'),
      h('div.npmsw-btns',
        h('button.btn.pri', { 'data-act': 'switch', on: { click: () => void api().npmSwitch() } }, 'Switch to the app'),
        h('button.btn', { 'data-act': 'not-now', on: { click: () => void api().npmNotNow() } }, 'Not now')));
  } else if (v.offer === 'bar' && d) {
    const back = v.phase === 'back' ? v.result : null;
    const line = back && back.command && !back.started ? `Back on the npm board. Start it as before: ${back.command}` : back ? 'Back on the npm board.' : 'Your npm board runs this data, so the app shows it and starts no hub of its own.';
    replace(el, h('div.npmsw-bar', h('span', line), h('button.btn.sm', { 'data-act': 'switch', on: { click: () => void api().npmSwitch() } }, 'Switch to the app')));
    el.className = 'npmsw bar';
    el.hidden = false;
    return;
  }
  if (!body) { el.hidden = true; return; }
  el.className = 'npmsw screen';
  replace(el, body);
  el.hidden = false;
}

function set(v: unknown): void {
  const next = v as NpmView;
  if (next && (next.phase === 'switching' || next.phase === 'going-back')) dismissed = false;
  view = next;
  render();
}

/** Starts following the switch's state; call once the page is up. */
export function initNpmSwitch(): void {
  if (!api().npmState) return;
  el = h('div.npmsw', { id: 'npm-switch', hidden: true });
  document.body.appendChild(el);
  api().onNpm(set);
  void api().npmState().then(set);
  (window as unknown as { __ravenryNpm: unknown }).__ravenryNpm = {
    view: () => view,
    switch: () => api().npmSwitch(),
    notNow: () => api().npmNotNow(),
    back: () => api().npmBack(),
    confirmBack: (on: boolean) => api().npmConfirmBack(on),
  };
}
