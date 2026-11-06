// The phone board (docs/PHONE.md): one page, four kinds of screen.
//
//   #/                 the sessions, Needs you first (picture 2)
//   #/s/<session key>  a session, live (picture 3)
//   #/cp/<id>          a checkpoint (pictures 4 and the checkpoints' phone frames)
//   #/fb/<id>          a photo or a voice note for it (picture 6)
//   #/p/<page key>     a page of the sidebar (the pages' phone frames)
//   #/pages            every page of the sidebar
//
// The shell gives a tap on an alert as `open`, Back as `back`.

import { h, replace } from '../../desktop/src/renderer/dom.ts';
import { connect, current } from './shell.ts';
import type { Alert } from './shell.ts';
import * as hub from './hub.ts';
import { parentOf } from './logic.ts';
import { sessionsScreen } from './sessions.ts';
import { sessionScreen } from './session.ts';
import { checkpointScreen, feedbackScreen } from './checkpoint.ts';
import { pageScreen, pagesListScreen } from './pages.ts';

export interface Screen { el: HTMLElement; update(): void; dispose(): void }

const root = document.getElementById('app')!;
let screen: Screen | null = null;
let route = '';

// Where Back goes: the screens the person came through, else the parent.
// The page keeps no browser history of its own; the shell's Back asks.
const stack: string[] = [];

export function go(to: string, { replace: rep = false } = {}): void {
  if (to === route) return;
  if (!rep && route) stack.push(route);
  location.replace('#' + to);
}

export function back(): void {
  const p = stack.pop() ?? parentOf(route);
  if (p === null) return;
  location.replace('#' + p);
}

/** True when Back has somewhere to go. */
export const canGoBack = (): boolean => stack.length > 0 || parentOf(route) !== null;

function show(): void {
  route = location.hash.replace(/^#/, '') || '/';
  if (screen) screen.dispose();
  const [, kind, ...rest] = route.split('/');
  const arg = decodeURIComponent(rest.join('/'));
  screen = kind === 's' ? sessionScreen(arg)
    : kind === 'cp' ? checkpointScreen(arg)
    : kind === 'fb' ? feedbackScreen(arg)
    : kind === 'p' ? pageScreen(arg)
    : kind === 'pages' ? pagesListScreen()
    : sessionsScreen();
  replace(root, screen.el, toastEl);
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- the toast

const toastEl = h('div.toast', { role: 'status', hidden: true });
let toastTimer: ReturnType<typeof setTimeout> | null = null;
export function toast(text: string, undo?: { label: string; run: () => void }): void {
  replace(toastEl, h('span', text), undo ? h('button.undo', { on: { click: () => { toastEl.hidden = true; undo.run(); } } }, undo.label) : null);
  toastEl.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, undo ? 6000 : 3500);
}

// ---------------------------------------------------------------- a sheet

/** A sheet from the bottom with a list of choices; resolves with the one tapped, or null. */
export function sheet(title: string | null, choices: { label: string; danger?: boolean; on?: boolean }[]): Promise<number | null> {
  return new Promise((done) => {
    const close = (i: number | null) => { el.remove(); done(i); };
    const el = h('div.sheet-bg', { on: { click: (e: Event) => { if (e.target === e.currentTarget) close(null); } } },
      h('div.sheet', title ? h('div.sheet-t', title) : null,
        choices.map((c, i) => h(`button.sheet-r${c.danger ? '.danger' : ''}${c.on ? '.on' : ''}`, { on: { click: () => close(i) } }, c.label))));
    document.body.appendChild(el);
  });
}

// ---------------------------------------------------------------- start

async function main(): Promise<void> {
  const sh = await connect();
  document.documentElement.dataset.platform = sh.hello.platform;
  hub.onSignedOutDo(() => { void sh.call('pair.reset').catch(() => toast('Signed out. Scan the code on the computer again.')); });
  hub.watch(() => screen?.update());
  sh.on('open', (m) => openAlert(m.alert as Alert));
  sh.on('back', () => {
    const handled = canGoBack();
    if (handled) back();
    void sh.call('back.done', { handled }).catch(() => {});
  });
  window.addEventListener('hashchange', show);
  setInterval(() => screen?.update(), 20000);
  show();
  await hub.start();
  if (sh.hello.pending) openAlert(sh.hello.pending);
}

/** An alert the person tapped: its checkpoint, else its session. */
function openAlert(a: Alert | null | undefined): void {
  if (!a) return;
  if (a.checkpoint && a.checkpoint.id) { go(`/cp/${encodeURIComponent(a.checkpoint.id)}`); return; }
  if (a.project && a.session) { go(`/s/${encodeURIComponent(`${a.project.id}/${a.session.surfaceId}`)}`); return; }
  go('/');
}

export const shellNow = (): ReturnType<typeof current> => current();

main().catch((e) => {
  replace(root, h('div.fatal', h('p', 'The board did not start.'), h('p.t2', String((e && e.message) || e))));
});
