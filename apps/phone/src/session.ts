// A session, live (picture 3): its header with Hand off, the real terminal
// (xterm.js on the pane's own stream, the same bytes the computer shows),
// then the dock: the question's answers as big buttons, the key bar, and
// the reply field with the microphone.
//
// A session in another terminal (cmux, iTerm2, Rex) has no pane stream: it
// shows the screen the hub last read, and no key bar.

import { h, replace, svg } from '../../desktop/src/renderer/dom.ts';
import { findSession, paneOf, sessionGroup, machineOf, assistantName } from '../../desktop/src/renderer/model.ts';
import type { HubProject, HubSession } from '../../desktop/src/renderer/model.ts';
import { TerminalView } from '../../desktop/src/renderer/terminal.ts';
import * as DI from '../../desktop/src/renderer/icons.ts';
import * as I from './icons.ts';
import * as hub from './hub.ts';
import { current } from './shell.ts';
import { checkpointOf, KEYS, quickAnswers } from './logic.ts';
import { back, go, sheet, toast } from './main.ts';
import type { Screen } from './main.ts';

const COLOR: Record<string, string> = { you: 'var(--you)', work: 'var(--work)', wait: 'var(--wait)', idle: 'var(--idle)' };
const enc = new TextEncoder();

export function sessionScreen(key: string): Screen {
  const el = h('div.scr.session');
  const head = h('header.sh');
  const termBox = h('div.term');
  const dock = h('div.dock');
  const qa = h('div.qa');
  const keys = h('div.keys');
  const field = h('input.field', { type: 'text', placeholder: 'Reply', enterkeyhint: 'send', autocomplete: 'off' }) as HTMLInputElement;
  const act = h('button.mic', { 'aria-label': 'Send' });
  const inrow = h('div.inrow', field, act);
  const banner = h('div.banner', { hidden: true });
  dock.append(banner, qa, keys, inrow);
  el.append(head, termBox, dock);

  let view: TerminalView | null = null;
  let attachedPane: string | null = null;
  let disposed = false;
  let sending = false;
  const sh = current();
  const speech = sh.has('speech');

  const found = () => findSession(hub.live.state, key);

  async function send(body: Record<string, unknown>, what: string): Promise<boolean> {
    const f = found();
    if (!f) return false;
    try {
      await hub.post('/api/send', { projectId: f.project.id, surfaceId: f.session.surfaceId, ...body });
      return true;
    } catch (e) { toast(`${what}: ${(e as Error).message}`); return false; }
  }

  async function reply(): Promise<void> {
    const text = field.value.trim();
    if (!text || sending) return;
    sending = true;
    const ok = await send({ text }, 'Not sent');
    sending = false;
    if (ok) { field.value = ''; paintAct(); field.blur(); }
  }

  function paintAct(): void {
    const typed = !!field.value.trim();
    act.classList.toggle('send', typed || !speech);
    replace(act, svg(typed || !speech ? I.SEND : I.MIC));
    act.setAttribute('aria-label', typed || !speech ? 'Send' : 'Speak');
  }
  field.addEventListener('input', paintAct);
  field.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); void reply(); } });
  act.addEventListener('click', async () => {
    if (field.value.trim() || !speech) { void reply(); return; }
    try {
      const r = await sh.call<{ text: string }>('speech');
      if (r && r.text) { field.value = r.text; paintAct(); field.focus(); }
    } catch (e) { toast((e as Error).message); }
  });

  function keyBytes(bytes: string): void {
    if (view && view.ready) view.type(bytes);
  }

  function paintHead(p: HubProject, s: HubSession): void {
    const g = sessionGroup(s);
    const pct = s.ctx && Number.isFinite(s.ctx.pct) ? Math.round(s.ctx.pct) : null;
    const m = machineOf(p, s);
    const who = assistantName(s.assistant);
    replace(head,
      h('button.icon-btn.fg', { 'aria-label': 'Back', on: { click: back } }, svg(I.BACK)),
      h('div.ti',
        h('div.n', h('span.sd', { style: { background: COLOR[g] || COLOR.idle } }), h('span.nm', s.topic || p.name), who ? h('span.as-tag', who) : null),
        h('div.s', h('span', p.name), m ? h('span.mt', svg(DI.MACHINE), m) : null, pct !== null ? h('span.num', `${pct}%`) : null)),
      h('button.hand', { on: { click: () => void handOff(p, s) } }, svg(I.HAND), 'Hand off'),
      h('button.icon-btn', { 'aria-label': 'More', on: { click: () => void more(p, s) } }, svg(I.KEBAB)));
  }

  async function handOff(p: HubProject, s: HubSession): Promise<void> {
    try { await hub.post('/api/handoff', { projectId: p.id, surfaceId: s.surfaceId }); toast('It hands off after the current task.'); } catch (e) { toast((e as Error).message); }
  }

  async function more(p: HubProject, s: HubSession): Promise<void> {
    const i = await sheet(s.topic || p.name, [{ label: 'Hand off now' }, { label: 'Close this session', danger: true }]);
    if (i === 0) {
      try { await hub.post('/api/handoff/start', { projectId: p.id, sessionId: s.sessionId }); toast('Handing off now.'); } catch (e) { toast((e as Error).message); }
    } else if (i === 1) {
      const sure = await sheet('Close it? The assistant in it ends.', [{ label: 'Close the session', danger: true }, { label: 'Keep it' }]);
      if (sure !== 0) return;
      try { await hub.post('/api/sessions/close', { sessionIds: [s.sessionId] }); toast('Closed.'); back(); } catch (e) { toast((e as Error).message); }
    }
  }

  function paintDock(p: HubProject, s: HubSession): void {
    const answers = sessionGroup(s) === 'you' ? quickAnswers(s) : [];
    replace(qa, answers.map((a) => h('button.btn.you', { on: { click: () => void send({ choice: a.choice }, 'Not sent') } }, a.label)));
    qa.hidden = !answers.length;
    const pane = paneOf(s);
    replace(keys, pane ? KEYS.map((k) => h(`button.key${k.red ? '.red' : ''}`, { 'aria-label': k.aria, on: { pointerdown: (e: Event) => e.preventDefault(), click: () => keyBytes(k.bytes) } }, k.icon ? svg(k.icon) : k.label)) : []);
    keys.hidden = !pane;
    field.placeholder = `Reply to ${assistantName(s.assistant) || 'the session'}`;
    void p;
  }

  async function attach(pane: string): Promise<void> {
    if (attachedPane === pane) return;
    attachedPane = pane;
    replace(termBox);
    view = new TerminalView(termBox);
    // The DOM renderer: xterm.js's WebGL one draws its glyphs at twice their
    // size on a high-density screen in Chromium's software GL (the emulator,
    // a headless browser), and a phone's few columns need no GPU.
    (view as unknown as { webgl: { dispose(): void } | null }).webgl?.dispose();
    view.term.options.fontSize = 11.5;
    view.term.options.fontFamily = "'Roboto Mono', 'DejaVu Sans Mono', 'Droid Sans Mono', ui-monospace, monospace";
    view.term.options.lineHeight = 1.25;
    try {
      const client = await hub.paneClient(pane);
      if (disposed) { client.close(); return; }
      await view.show({ client, pane });
      view.term.blur();
    } catch (e) {
      replace(termBox, h('div.term-off', h('p', 'The terminal did not open.'), h('p.t2', (e as Error).message)));
      attachedPane = null;
      view = null;
    }
  }

  function paintScreen(s: HubSession): void {
    const lines = s.screen || [];
    replace(termBox, h('pre.term-text', lines.join('\n') || 'The computer has not read this screen yet.'));
  }

  const update = () => {
    if (disposed) return;
    const f = found();
    if (!f) {
      replace(head, h('button.icon-btn.fg', { 'aria-label': 'Back', on: { click: back } }, svg(I.BACK)), h('div.ti', h('div.n', 'This session ended')));
      return;
    }
    const cp = checkpointOf(hub.checkpoints(), f.project.id, f.session);
    replace(banner, cp ? h('button.cpbar', { on: { click: () => go(`/cp/${encodeURIComponent(cp.id)}`) } }, h('span.sd', { style: { background: 'var(--you)' } }), h('span.tx', cp.kind === 'approve' ? 'Wants to run a command' : cp.kind === 'secret' ? 'Needs a secret' : 'Waits for your answer'), h('span.go', 'Open')) : null);
    banner.hidden = !cp;
    paintHead(f.project, f.session);
    paintDock(f.project, f.session);
    const pane = paneOf(f.session);
    if (pane) void attach(pane);
    else paintScreen(f.session);
  };
  paintAct();
  update();
  return {
    el, update,
    dispose: () => {
      disposed = true;
      const a = view?.attached;
      view?.hide();
      view?.term.dispose();
      if (a) a.client.close();
      void enc;
    },
  };
}
