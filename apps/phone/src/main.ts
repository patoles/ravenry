// The app's own screens (docs/PHONE.md): what the hub's board, the app's
// home, cannot do in a page. The home is the board itself (src/board.ts):
// this page shows only
//
//   #/cp/<id>          a checkpoint (the checkpoints' phone frames): a
//                      secret, a pick, a drive, or an ask or a command
//                      opened from its alert
//   #/fb/<id>          a photo or a voice note for it (picture 6)
//   #/settings         the app's settings, behind the board's gear
//
// and anything else goes back to the board. The shell gives a tap on an
// alert as `open`, Back as `back`.

import { h, replace } from '../../desktop/src/renderer/dom.ts';
import { connect, current } from './shell.ts';
import type { Alert } from './shell.ts';
import * as hub from './hub.ts';
import { parentOf } from './logic.ts';
import { checkpointScreen, feedbackScreen } from './checkpoint.ts';
import { settingsScreen } from './settings.ts';

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
  if (p === null || p === '/') { toBoard(); return; }
  location.replace('#' + p);
}

/** The board, the app's home (src/board.ts); a toast said there once it shows. */
function toBoard(): void {
  if (toastEl.textContent && !toastEl.hidden) { try { sessionStorage.setItem('rv-toast', toastEl.textContent); } catch { /* none */ } }
  location.replace('/');
}

/** True when Back has somewhere to go. */
export const canGoBack = (): boolean => stack.length > 0 || parentOf(route) !== null;

function show(): void {
  route = location.hash.replace(/^#/, '') || '/';
  if (screen) screen.dispose();
  const [, kind, ...rest] = route.split('/');
  const arg = decodeURIComponent(rest.join('/'));
  if (kind !== 'cp' && kind !== 'fb' && kind !== 'settings') { toBoard(); return; }
  screen = kind === 'cp' ? checkpointScreen(arg)
    : kind === 'fb' ? feedbackScreen(arg)
    : settingsScreen();
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
    // Android's Back closes it (main's back handler: openSheet), and so does a swipe down.
    (el as HTMLElement & { close?: () => void }).close = () => close(null);
    const card = el.querySelector('.sheet') as HTMLElement;
    let y0 = -1, dy = 0;
    card.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; dy = 0; }, { passive: true });
    card.addEventListener('touchmove', (e) => { if (y0 < 0) return; dy = Math.max(0, e.touches[0].clientY - y0); card.style.transform = `translateY(${dy}px)`; }, { passive: true });
    card.addEventListener('touchend', () => { y0 = -1; if (dy > 80) close(null); else card.style.transform = ''; });
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
    // A sheet on top closes first; then one screen up.
    const open = [...document.querySelectorAll('.sheet-bg')].pop() as (HTMLElement & { close?: () => void }) | undefined;
    if (open && open.close) { open.close(); void sh.call('back.done', { handled: true }).catch(() => {}); return; }
    const handled = canGoBack();
    if (handled) back();
    void sh.call('back.done', { handled }).catch(() => {});
  });
  window.addEventListener('hashchange', show);
  setInterval(() => screen?.update(), 20000);
  show();
  // A launch onto this page (the activity rebuilt on a checkpoint's screen by a theme switch, say):
  // once the computer answered and the screen drew, the launch's still mark goes, as the board's
  // bar tells it (board.ts). Without this it waited 12 s for a bar this page has not, then said
  // "Your Mac didn't answer" over a screen that worked (pick-shots, 2026-11-15).
  let told = false;
  const tellLaunch = (): void => {
    if (told || !sh.hello.launch || !hub.live.state) return;
    told = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = document.querySelector('.pcp-top .lab svg, .pcp-top svg, h1, h2');
      const r = el ? el.getBoundingClientRect() : { x: 20, y: 20, width: 24, height: 24 };
      void sh.call('ink.ready', { x: r.x, y: r.y, w: r.width || 24, h: r.height || 24, dpr: devicePixelRatio, dark: matchMedia('(prefers-color-scheme: dark)').matches }).catch(() => {});
    }));
  };
  hub.watch(tellLaunch);
  await hub.start();
  tellLaunch();
  if (sh.hello.pending) openAlert(sh.hello.pending);
}

/** An alert the person tapped: its checkpoint, else its session. */
function openAlert(a: Alert | null | undefined): void {
  if (!a) return;
  if (a.checkpoint && a.checkpoint.id) { go(`/cp/${encodeURIComponent(a.checkpoint.id)}`); return; }
  location.replace(a.project ? `/#${encodeURIComponent(a.project.id)}${a.session ? `/${encodeURIComponent(a.session.surfaceId)}` : ''}` : '/');
}

export const shellNow = (): ReturnType<typeof current> => current();

main().catch((e) => {
  replace(root, h('div.fatal', h('p', 'The board did not start.'), h('p.t2', String((e && e.message) || e))));
});
