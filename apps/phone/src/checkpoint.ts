// A checkpoint on the phone (the checkpoints' phone frames, picked A A A,
// and picture 4): the whole screen, opened from its alert or its row.
//
//   ask      the question, a clock that says how long the agent waited and
//            when it gives up, one answer per line, then a field for an
//            answer in the person's own words; a photo or a voice note can
//            go with it (picture 6)
//   approve  the command, then Folder, Machine and Pane on labelled lines,
//            the warnings with whose they are, the agent's words labelled
//            as its own; Edit, Refuse, and Run, which always asks for a
//            fingerprint first
//   secret   what it is for and the command it goes to, the field inside
//            the card (the shell's private keyboard, so the page never sees
//            the secret), and Send to the terminal
//
// Answers go to the hub as the device (POST /api/checkpoints/answer), the
// person's answer (hub/docs/PERSON.md). Every word about the checkpoint is
// the hub's (its `words`, hub/server/cpwords.mjs), its tokens filled for
// the phone (reader below).

import { h, replace, svg } from '../../desktop/src/renderer/dom.ts';
import * as DI from '../../desktop/src/renderer/icons.ts';
import { assistantName, findSession, secondLine } from '../../desktop/src/renderer/model.ts';
import {
  characters, fill, kindOf, secretProblem, timeOf, warningsFor,
} from '../../desktop/src/renderer/checkpoints.ts';
import type { CheckpointWords, HubCheckpoint, Reader } from '../../desktop/src/renderer/checkpoints.ts';
import * as I from './icons.ts';
import * as hub from './hub.ts';
import { current } from './shell.ts';
import { dropLine, mmss, waitOf } from './logic.ts';
import { newPick, pickView } from './pick.ts';
import type { PickUI } from './pick.ts';
import { sayPathOn } from '../../../hub/public/homepath.mjs';
import { keyParts } from '../../../hub/public/keys.mjs';
import type { Drop } from './logic.ts';
import { back, go, toast } from './main.ts';
import type { Screen } from './main.ts';
import { bioWord, deviceWord, t as say, t as word } from './strings.ts';

/** Every checkpoint the hub lists, closed ones it still holds included. */
function find(id: string): HubCheckpoint | null {
  const all = (hub.live.state?.checkpoints || []) as HubCheckpoint[];
  return all.find((c) => c && c.id === id) || null;
}

/** How the phone fills the words' tokens: its answers say "phone", it is not on the hub's computer, its clock. */
const reader = (pane: string | null = null): Reader => ({ me: 'phone', onHub: false, time: (iso) => timeOf(iso, Date.now()), pane });

/** The machine a checkpoint runs on, as the phone says it: the hub's words, else this computer's name. */
const machineOfCp = (cp: HubCheckpoint): string => (cp.words ? cp.words.machine.away : current().hello.hub.name);

async function answer(cp: HubCheckpoint, reply: Record<string, unknown>): Promise<void> {
  await hub.post('/api/checkpoints/answer', { id: cp.id, by: 'phone', ...reply });
  void current().call('alerts.clear', { id: `cp:${cp.id}` }).catch(() => {});
}

function topBar(cp: HubCheckpoint, icon: string): HTMLElement {
  return h('div.pcp-top',
    h('button.icon-btn.fg', { 'aria-label': 'Close', on: { click: back } }, svg(I.X18)), h('span.sp'),
    h('span.lab', svg(icon), cp.words?.top || ''), h('span.sp'), h('span.icon-sp'));
}

function fromLine(cp: HubCheckpoint): HTMLElement[] {
  const f = cp.projectId && cp.surfaceId ? findSession(hub.live.state, `${cp.projectId}/${cp.surfaceId}`) : null;
  const name = f ? f.session.topic || f.project.name : cp.page ? cp.page.title : say('session.unnamed');
  const asst = assistantName(cp.assistant);
  const project = f ? f.project.name : cp.project || null;
  return [
    h('div.pcp-from', h('span.sd', { style: { background: 'var(--you)' } }), h('span.nm', name), asst ? h('span.as-tag', asst) : null),
    h('div.pcp-sub', `${project ? project + ' on ' : 'On '}${machineOfCp(cp)}`),
  ];
}

function waitBox(cp: HubCheckpoint): HTMLElement {
  const w = waitOf(cp, Date.now());
  return h('div.pwait', h('div.r', h('b', w.label), w.until ? h('span.s.num', `Gives up at ${w.until}`) : null),
    h('div.bar', h('div.f', { style: { width: `${w.pct}%`, background: 'var(--you)' } })));
}

function doneView(cp: HubCheckpoint, w: CheckpointWords): HTMLElement {
  const a = w.after || { ok: false, head: '', small: null, big: null, command: null, text: '' };
  return h('div.pcp.done',
    h('div.pcp-top', h('button.icon-btn.fg', { 'aria-label': 'Close', on: { click: back } }, svg(I.X18)), h('span.sp')),
    ...fromLine(cp),
    h(`div.after${a.ok ? '.ok' : ''}`, h('span.ai', svg(a.ok ? DI.DONE : DI.ENDED)), h('b', fill(a.head, w, reader()))),
    a.small ? h('p.det', a.small) : null,
    a.big ? h('h2', a.big) : null,
    a.command ? h('pre.pcmd', a.command) : null,
    h('p.det', fill(a.text, w, reader())),
    h('div.pcp-b', h('button.btn.big', { on: { click: back } }, 'Back')));
}

// ---------------------------------------------------------------- ask

function askView(cp: HubCheckpoint, w: CheckpointWords, ui: UI, repaint: () => void): HTMLElement {
  const sh = current();
  const t = w;
  const { text, checks } = w.checks;
  const opts = cp.options || [];
  const pick = async (i: number) => {
    if (ui.busy) return;
    ui.busy = true; repaint();
    try { await answer(cp, { choice: i }); toast(`Sent: ${opts[i]}`); back(); } catch (e) { ui.busy = false; ui.error = (e as Error).message; repaint(); }
  };
  const field = h('input.f', { type: 'text', placeholder: 'Or answer in your own words', enterkeyhint: 'send', autocomplete: 'off', value: ui.draft }) as HTMLInputElement;
  const sendText = async () => {
    const v = field.value.trim();
    if (!v || ui.busy) return;
    ui.busy = true; ui.draft = v; repaint();
    try { await answer(cp, { text: v }); toast('Sent.'); back(); } catch (e) { ui.busy = false; ui.error = (e as Error).message; repaint(); }
  };
  field.addEventListener('input', () => { ui.draft = field.value; paintMic(); });
  field.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); void sendText(); } });
  const mic = h('button.mic', { 'aria-label': 'Speak' });
  const paintMic = () => {
    const typed = !!field.value.trim();
    replace(mic, svg(typed || !sh.has('speech') ? I.SEND : I.MIC));
    mic.classList.toggle('send', typed);
  };
  mic.addEventListener('click', async () => {
    if (field.value.trim() || !sh.has('speech')) { void sendText(); return; }
    try { const r = await sh.call<{ text: string }>('speech'); if (r && r.text) { field.value = r.text; ui.draft = r.text; paintMic(); } } catch (e) { toast((e as Error).message); }
  });
  paintMic();
  const drops = sh.has('photo') || sh.has('voice')
    ? h('div.two.drops',
      sh.has('photo') ? h('button.btn', { on: { click: () => go(`/fb/${encodeURIComponent(cp.id)}?do=photo`) } }, svg(I.CAMERA), 'Add a photo') : null,
      sh.has('voice') ? h('button.btn', { on: { click: () => go(`/fb/${encodeURIComponent(cp.id)}?do=voice`) } }, svg(I.MIC), 'Record a voice note') : null)
    : null;
  return h('div.pcp',
    topBar(cp, I.CLOCK), ...fromLine(cp),
    h('h2', t.head),
    text ? h('p.det', text) : null,
    checks.length ? h('div.chk', h('div.lbl', 'Check that'), checks.map((c, i) => h('div.ci', h('span.cn', String(i + 1)), h('span', c)))) : null,
    waitBox(cp),
    ui.error ? h('p.err', ui.error) : null,
    h('div.pcp-b',
      drops,
      opts.map((o, i) => h('button.btn.big', { disabled: ui.busy, on: { click: () => void pick(i) } }, o)),
      cp.free_text ? h('div.pfield', field, mic) : null));
}

// ---------------------------------------------------------------- approve

function approveView(cp: HubCheckpoint, w: CheckpointWords, ui: UI, repaint: () => void): HTMLElement {
  const sh = current();
  const machine = machineOfCp(cp);
  const f = cp.projectId && cp.surfaceId ? findSession(hub.live.state, `${cp.projectId}/${cp.surfaceId}`) : null;
  const command = ui.editing ? ui.edit : String(cp.command || '');
  const edited = ui.editing && ui.edit.trim() !== String(cp.command || '').trim();
  const run = async () => {
    const edited = ui.editing && ui.edit.trim() !== String(cp.command || '').trim();
    if (ui.busy) return;
    if (!sh.has('biometric')) { ui.error = word('phone.runNeedsApp', { bio: bioWord(sh.hello.platform) }); repaint(); return; }
    try {
      await sh.call('biometric', { title: `Run on ${machine}`, subtitle: (ui.editing ? ui.edit : String(cp.command || '')).split('\n')[0].slice(0, 120) });
    } catch (e) { ui.error = (e as Error).message; repaint(); return; }
    ui.busy = true; repaint();
    try {
      await answer(cp, edited ? { approve: true, command: ui.edit } : { approve: true });
      toast(`Running on ${machine}.`);
      back();
    } catch (e) { ui.busy = false; ui.error = (e as Error).message; repaint(); }
  };
  const refuse = async () => {
    if (ui.busy) return;
    ui.busy = true; repaint();
    try { await answer(cp, ui.reason.trim() ? { decline: true, reason: ui.reason.trim() } : { decline: true }); toast('Refused.'); back(); } catch (e) { ui.busy = false; ui.error = (e as Error).message; repaint(); }
  };
  const runLabel = h('span', edited ? `Run the edit on ${machine}` : `Run on ${machine}`);
  const runBtn = h('button.btn.pri.big', { disabled: ui.busy, on: { click: () => void run() } }, svg(I.FINGER), runLabel);
  // Typing in the command changes the button's words, not the screen, so the field keeps its focus.
  function paintRun(): void {
    const changed = ui.edit.trim() !== String(cp.command || '').trim();
    runLabel.textContent = changed ? `Run the edit on ${machine}` : `Run on ${machine}`;
  }
  const cmdEl = ui.editing
    ? h('textarea.pcmd.edit', { rows: '3', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', on: { input: (e: Event) => { ui.edit = (e.target as HTMLTextAreaElement).value; paintRun(); } } }, ui.edit)
    : h('pre.pcmd', command);
  const env = cp.env && Object.keys(cp.env).length ? Object.entries(cp.env) : [];
  const warnings = warningsFor(cp, w, command);
  const reasonField = h('input.f', { type: 'text', placeholder: `Why not? (optional, ${w.who} reads it)`, value: ui.reason, on: { input: (e: Event) => { ui.reason = (e.target as HTMLInputElement).value; } } });
  return h('div.pcp',
    topBar(cp, DI.RUN), ...fromLine(cp),
    cmdEl,
    h('div.pkv',
      h('span', 'Folder'), h('span.mono', cp.cwd ? sayPathOn(cp.cwd, cp.machine, hub.live.state?.homes) : 'Home folder'),
      h('span', 'Machine'), h('span', machine),
      h('span', 'Pane'), h('span', f ? `This session, ${f.session.topic || f.project.name}` : 'A new pane'),
      env.map(([k, v]) => [h('span.mono', k), h('span.mono', String(v))])),
    warnings.map((x) => h(`div.prisk${x.from === 'agent' ? '.agent' : ''}`, svg(DI.WARN), x.from === 'agent' ? h('span', h('span.who', x.label), ' ', x.text) : h('span', x.text))),
    cp.why ? h('p.psays', h('span', `${w.who} says:`), ' ', cp.why) : null,
    waitBox(cp),
    ui.error ? h('p.err', ui.error) : null,
    h('div.pcp-b',
      ui.refusing
        ? [h('div.pfield', reasonField), h('div.two', h('button.btn', { on: { click: () => { ui.refusing = false; repaint(); } } }, 'Back'), h('button.btn.bad', { disabled: ui.busy, on: { click: () => void refuse() } }, say('checkpoint.refuse')))]
        : [h('div.two',
          h('button.btn', { on: { click: () => { ui.editing = !ui.editing; if (ui.editing && !ui.edit) ui.edit = String(cp.command || ''); repaint(); } } }, ui.editing ? 'Done editing' : 'Edit'),
          h('button.btn.bad-t', { on: { click: () => { ui.refusing = true; repaint(); } } }, say('checkpoint.refuse'))),
        runBtn]));
}

// ---------------------------------------------------------------- secret

function secretView(cp: HubCheckpoint, w: CheckpointWords, ui: UI, repaint: () => void, mount: (fld: HTMLElement) => void, reveal: (on: boolean) => void): HTMLElement {
  const sh = current();
  const native = sh.has('secret');
  const t = w;
  const to = cp.secret?.to;
  const goes = to === 'input' ? 'that terminal' : 'that command';
  // In the app the shell's private field lies over .slot, transparent: the
  // page draws the field around it, the count and the eye, never the text.
  const fld = h('div.psfld', native
    ? [h('span.slot', ui.count ? '' : h('span.ph', 'Type it here')), ui.count ? h('span.n.num', String(ui.count)) : null,
      h('button.eye', { 'aria-label': ui.reveal ? say('checkpoint.secretHide') : say('checkpoint.secretShow'), on: { click: () => { ui.reveal = !ui.reveal; reveal(ui.reveal); repaint(); } } }, svg(ui.reveal ? DI.EYE_OFF : DI.EYE))]
    : [h('input.sfin', { type: 'password', autocomplete: 'off', placeholder: 'Type it here', on: { input: (e: Event) => { ui.count = (e.target as HTMLInputElement).value.length; } } })]);
  if (native) mount(fld);
  const send = async () => {
    if (ui.busy) return;
    ui.busy = true; ui.error = null; repaint();
    try {
      if (native) await sh.call('secret.send');
      else {
        const inp = fld.querySelector('input') as HTMLInputElement;
        const v = inp.value;
        const bad = secretProblem(v);
        if (bad) throw new Error(bad);
        inp.value = '';
        await answer(cp, { secret: v });
      }
      toast('Sent to the terminal.');
      back();
    } catch (e) { ui.busy = false; ui.error = (e as Error).message; repaint(); }
  };
  return h('div.pcp',
    topBar(cp, DI.KEY), ...fromLine(cp),
    h('h2.sm', t.head),
    cp.command ? h('p.det', 'For ', h('span.mono', cp.command)) : t.body ? h('p.det', t.body) : null,
    fld,
    h('ul.pprom', h('li', svg(DI.LOCK), `Goes straight to ${goes}, not to ${w.who}`), h('li', svg(DI.LOCK), `Not kept in logs, history or on this ${deviceWord(sh.hello.form)}`)),
    ui.count && native ? h('p.t2.small', characters(ui.count)) : null,
    ui.error ? h('p.err', ui.error) : null,
    h('div.pcp-b', h('button.btn.pri.big', { disabled: ui.busy, on: { click: () => void send() } }, say('checkpoint.secretSend'))));
}

// ---------------------------------------------------------------- drive

function driveView(cp: HubCheckpoint, w: CheckpointWords, ui: UI, repaint: () => void): HTMLElement {
  const sh = current();
  const action = cp.drive?.action || 'input';
  // The hub's words, with the pane by the name the board shows (never its id).
  const dw = w.drive!.phone;
  const say = (s: string) => fill(s, w, reader());
  const words = { title: say(dw.title), what: dw.what, yes: dw.yes.map((y) => ({ ...y, said: say(y.said) })) };
  const input = String(cp.drive?.input || '');
  const reason = String((cp.drive as { reason?: string } | undefined)?.reason || '').trim();
  const allow = async (y: (typeof words.yes)[number]) => {
    if (ui.busy) return;
    // Letting an agent act on a pane it did not start is as strong as
    // running a command there: a fingerprint first, always (docs/PHONE.md
    // section 5).
    if (!sh.has('biometric')) { ui.error = word('phone.allowNeedsApp', { bio: bioWord(sh.hello.platform) }); repaint(); return; }
    try { await sh.call('biometric', { title: y.label, subtitle: words.title }); } catch (e) { ui.error = (e as Error).message; repaint(); return; }
    ui.busy = true; ui.error = null; repaint();
    try { await answer(cp, { approve: true, allow: y.allow }); toast(y.said); back(); } catch (e) { ui.busy = false; ui.error = (e as Error).message; repaint(); }
  };
  const refuse = async () => {
    if (ui.busy) return;
    ui.busy = true; repaint();
    try { await answer(cp, { decline: true }); toast('Refused.'); back(); } catch (e) { ui.busy = false; ui.error = (e as Error).message; repaint(); }
  };
  return h('div.pcp',
    topBar(cp, I.KEYS16), ...fromLine(cp),
    h('h2.sm', words.title),
    words.what ? h('p.det', words.what) : null,
    input ? [h('div.plbl', action === 'override' ? 'It would set' : word('checkpoint.wouldPress')),
      h('div.ptyped', action === 'override' ? input : keyParts(input).map((x) => (x.kind === 'key' ? h('span.kc', x.text) : h('span', x.text))))] : null,
    reason ? h('p.psays', h('span', `${w.who} says:`), ' ', reason) : null,
    waitBox(cp),
    ui.error ? h('p.err', ui.error) : null,
    h('div.pcp-b',
      words.yes.map((y) => h('button.btn.big.popt', { disabled: ui.busy, on: { click: () => void allow(y) } }, svg(I.FINGER), y.sub ? h('span.two-l', h('span', y.label), h('span.s', y.sub)) : h('span', y.label))),
      h('button.btn.bad-t', { disabled: ui.busy, on: { click: () => void refuse() } }, word('checkpoint.refuse'))));
}

// ---------------------------------------------------------------- the screen

interface UI { busy: boolean; error: string | null; draft: string; editing: boolean; edit: string; refusing: boolean; reason: string; count: number; reveal: boolean }

const picks = new Map<string, PickUI>();

export function checkpointScreen(id: string): Screen {
  const el = h('div.scr.cpscr');
  const ui: UI = { busy: false, error: null, draft: '', editing: false, edit: '', refusing: false, reason: '', count: 0, reveal: false };
  // A pick keeps its picture, circle and note while the page lives, so a
  // look at another screen and back loses nothing.
  let pk = picks.get(id);
  if (!pk) { pk = newPick(); picks.set(id, pk); }
  const pkNow: PickUI = pk;
  const sh = current();
  let secretOpen = false;
  let secretField: HTMLElement | null = null;
  let lastKey = '';
  const offs: (() => void)[] = [];

  const rectOf = (e: HTMLElement) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  const slotRect = () => { const e = secretField?.querySelector('.slot') as HTMLElement | null; return e ? rectOf(e) : secretField ? rectOf(secretField) : { x: 0, y: 0, w: 0, h: 0 }; };
  const placeSecret = () => {
    if (!secretField || !document.body.contains(secretField)) return;
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    if (!secretOpen) { secretOpen = true; void sh.call('secret.open', { checkpoint: id, rect: slotRect(), dark, size: 16 }).catch((e) => { ui.error = (e as Error).message; paint(true); }); }
    else void sh.call('secret.move', { rect: slotRect(), reveal: ui.reveal }).catch(() => {});
  };
  offs.push(sh.on('secret.count', (m) => { ui.count = Number(m.n) || 0; paint(true); }));
  offs.push(sh.on('secret.done', (m) => { if (m.ok) { toast('Sent to the terminal.'); back(); } else { ui.error = String(m.error || 'It was not sent.'); paint(true); } }));
  const onResize = () => placeSecret();
  window.addEventListener('resize', onResize);

  function paint(force = false): void {
    const cp = find(id);
    // A pick is drawn again only when its state changes: a minute passing
    // must not take the picture from under a finger or a note being typed.
    const key = cp ? `${cp.state}|${!!cp.words}|${ui.busy}|${ui.error}|${ui.editing}|${ui.refusing}|${ui.count}|${cp.kind === 'pick' ? (cp.variants || []).map((v) => (v as { video?: string }).video || '').join() : Math.floor(Date.now() / 30000)}` : 'gone';
    if (!force && key === lastKey) return;
    lastKey = key;
    if (!cp) {
      replace(el, h('div.pcp', h('div.pcp-top', h('button.icon-btn.fg', { 'aria-label': 'Close', on: { click: back } }, svg(I.X18))),
        h('h2.sm', hub.live.state ? 'This checkpoint is no longer open.' : 'Reaching the computer...'),
        hub.live.state ? h('p.det', 'It was answered, withdrawn or ran out before this screen opened.') : null));
      return;
    }
    // The hub's state carries every checkpoint with its words.
    const w = cp.words;
    if (!w) return;
    if (cp.state !== 'open') { closeSecret(); replace(el, doneView(cp, w)); return; }
    const repaint = () => paint(true);
    const k = kindOf(cp);
    const view = cp.kind === 'pick' ? pickView(cp, w, pkNow, { topBar, fromLine, answer, repaint, done: (said) => { picks.delete(id); toast(said); back(); } })
      : cp.kind === 'drive' && w.drive ? driveView(cp, w, ui, repaint)
      : k === 'ask' ? askView(cp, w, ui, repaint)
      : k === 'approve' ? approveView(cp, w, ui, repaint)
      : k === 'secret' ? secretView(cp, w, ui, repaint, (f) => { secretField = f; }, (on) => { void sh.call('secret.move', { rect: slotRect(), reveal: on }).catch(() => {}); })
      : h('div.pcp', topBar(cp, DI.ASK), ...fromLine(cp), h('h2.sm', w.head),
        h('div.pcp-b', h('button.btn.big', { on: { click: () => void answer(cp, { decline: true }).then(back, (e) => toast((e as Error).message)) } }, 'Decline')));
    const focusDraft = document.activeElement && (document.activeElement as HTMLElement).tagName === 'TEXTAREA';
    replace(el, view);
    if (focusDraft) (el.querySelector('textarea') as HTMLTextAreaElement | null)?.focus();
    if (k === 'secret' && secretField) requestAnimationFrame(placeSecret);
  }

  function closeSecret(): void {
    if (secretOpen) { secretOpen = false; void sh.call('secret.close').catch(() => {}); }
  }

  paint(true);
  return {
    el,
    update: () => paint(false),
    dispose: () => { closeSecret(); window.removeEventListener('resize', onResize); for (const f of offs) f(); },
  };
}

// ---------------------------------------------------------------- photo and voice note (picture 6)

interface Fb { drops: (Drop & { thumb?: string | null })[]; note: string; choice: number | null; recording: number | null; busy: boolean; error: string | null }
const fbs = new Map<string, Fb>();

export function feedbackScreen(arg: string): Screen {
  const [id, query] = arg.split('?');
  const want = new URLSearchParams(query || '').get('do');
  const sh = current();
  let fb = fbs.get(id);
  if (!fb) { fb = { drops: [], note: '', choice: null, recording: null, busy: false, error: null }; fbs.set(id, fb); }
  const st = fb;
  const el = h('div.scr.fbscr');
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;
  let seen = !!find(id);

  const cpNow = () => find(id);
  const projectOf = (cp: HubCheckpoint | null) => (cp && cp.projectId) || null;

  async function photo(): Promise<void> {
    const cp = cpNow();
    st.error = null;
    try {
      const r = await sh.call<{ path: string; short: string; name: string; thumb?: string }>('photo', { projectId: projectOf(cp) });
      if (r && r.path) st.drops.push({ kind: 'photo', name: r.name, path: r.short || r.path, thumb: r.thumb || null });
    } catch (e) { st.error = (e as Error).message; }
    paint();
  }
  async function startVoice(): Promise<void> {
    st.error = null;
    try { await sh.call('voice.start'); st.recording = Date.now(); tick(); } catch (e) { st.error = (e as Error).message; }
    paint();
  }
  async function stopVoice(): Promise<void> {
    if (st.recording === null) return;
    const cp = cpNow();
    try {
      const r = await sh.call<{ path: string; short: string; name: string; ms: number }>('voice.stop', { projectId: projectOf(cp) });
      if (r && r.path) st.drops.push({ kind: 'voice', name: r.name, path: r.short || r.path, ms: r.ms });
    } catch (e) { st.error = (e as Error).message; }
    st.recording = null;
    if (timer) { clearInterval(timer); timer = null; }
    paint();
  }
  // While it records, only the clock and the wave move, so the line being
  // typed keeps its focus.
  function tick(): void {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      if (disposed || st.recording === null) return;
      const ms = Date.now() - st.recording;
      const tm = el.querySelector('.rec .tm');
      if (tm) tm.textContent = mmss(ms);
      el.querySelectorAll('.rec .wave i').forEach((b, i) => { (b as HTMLElement).style.height = `${4 + Math.round(Math.abs(Math.sin(i * 1.7 + ms / 300)) * 18)}px`; });
    }, 250);
  }

  async function sendAll(): Promise<void> {
    if (st.busy) return;
    if (st.recording !== null) await stopVoice();
    const cp = cpNow();
    const f = cp && cp.projectId && cp.surfaceId ? findSession(hub.live.state, `${cp.projectId}/${cp.surfaceId}`) : null;
    const topic = f ? f.session.topic || f.project.name : 'the session';
    const opts = cp?.options || [];
    const ans = st.choice !== null ? opts[st.choice] || null : null;
    const line = dropLine({ at: Date.now(), topic, answer: ans, drops: st.drops, note: st.note });
    st.busy = true; st.error = null; paint();
    try {
      if (cp && cp.state === 'open' && cp.free_text) {
        await answer(cp, { text: line.text });
      } else {
        if (cp && cp.state === 'open' && st.choice !== null) await answer(cp, { choice: st.choice });
        if (f) await hub.post('/api/send', { projectId: f.project.id, surfaceId: f.session.surfaceId, text: line.text });
      }
      fbs.delete(id);
      toast(`Sent to ${topic}.`);
      go('/', { replace: true });
    } catch (e) { st.busy = false; st.error = (e as Error).message; paint(); }
  }

  function paint(): void {
    const cp = cpNow();
    const f = cp && cp.projectId && cp.surfaceId ? findSession(hub.live.state, `${cp.projectId}/${cp.surfaceId}`) : null;
    const topic = f ? f.session.topic || f.project.name : 'the session';
    const asst = (cp && assistantName(cp.assistant)) || 'the agent';
    const opts = cp?.options || [];
    const ans = st.choice !== null ? opts[st.choice] || null : null;
    const preview = dropLine({ at: Date.now(), topic, answer: ans, drops: st.drops, note: st.note });
    const photos = st.drops.filter((d) => d.kind === 'photo');
    const voices = st.drops.filter((d) => d.kind === 'voice');
    const recMs = st.recording !== null ? Date.now() - st.recording : 0;
    const bars = Array.from({ length: 44 }, (_, i) => 4 + Math.round(Math.abs(Math.sin(i * 1.7 + recMs / 300)) * 18));
    const note = h('input.f', { type: 'text', placeholder: 'Add a line (optional)', value: st.note, on: { input: (e: Event) => { st.note = (e.target as HTMLInputElement).value; } } });
    replace(el, h('div.fb',
      h('div.sh.fbh', h('button.icon-btn.fg', { 'aria-label': 'Back', on: { click: back } }, svg(I.BACK)),
        h('div.ti', h('div.n', h('span.sd', { style: { background: 'var(--you)' } }), h('span.nm', topic), cp && assistantName(cp.assistant) ? h('span.as-tag', assistantName(cp.assistant)!) : null),
          h('div.s', `${f && secondLine(topic, f.project.name) ? `${f.project.name} on` : 'On'} ${cp ? machineOfCp(cp) : current().hello.hub.name}`))),
      ans ? h('span.ans', svg(I.NO), `Your answer: ${ans}`) : opts.length ? h('div.anspick', opts.map((o, i) => h(`button.chip${st.choice === i ? '.on' : ''}`, { on: { click: () => { st.choice = st.choice === i ? null : i; paint(); } } }, o))) : null,
      h('h2', 'What did you see?'),
      h('div.att',
        photos.map((d) => h('div.thumb', d.thumb ? h('img', { src: d.thumb, alt: '' }) : h('span.tn', d.name),
          h('button.x', { 'aria-label': 'Remove', on: { click: () => { st.drops.splice(st.drops.indexOf(d), 1); paint(); } } }, svg(I.CLOSE_W)))),
        sh.has('photo') ? h('button.addt', { on: { click: () => void photo() } }, svg(I.CAMERA), photos.length ? 'Take another' : 'Take a photo') : null),
      st.recording !== null
        ? h('div.rec', h('span.dot'), h('span.tm.num', mmss(recMs)), h('span.wave', bars.map((b) => h('i', { style: { height: `${b}px` } }))), h('button.stop', { 'aria-label': 'Stop', on: { click: () => void stopVoice() } }, svg(I.STOP)))
        : sh.has('voice') ? h('button.rec.idle', { on: { click: () => void startVoice() } }, svg(I.MIC), voices.length ? 'Record another voice note' : 'Record a voice note') : null,
      voices.map((d) => h('div.vn', svg(I.MIC), h('span', d.name), h('span.num.t2', mmss(d.ms || 0)), h('button.x2', { 'aria-label': 'Remove', on: { click: () => { st.drops.splice(st.drops.indexOf(d), 1); paint(); } } }, svg(DI.CLOSE)))),
      note,
      h('div.arr', h('span.lbl', 'It arrives in the session as'),
        h('div.arrive', h('div', h('span.o', '› '), h('span.w', preview.head)), preview.lines.map((l) => h('div.d', `  └ ${l}`)))),
      st.error ? h('p.err', st.error) : null,
      h('div.fb-b', h('button.btn.pri', { disabled: st.busy || (!st.drops.length && !st.note.trim() && st.choice === null && st.recording === null), on: { click: () => void sendAll() } }, `Send to ${asst}`),
        st.recording !== null ? h('div.say', 'Stop the recording first, or Send stops it for you.') : null)));
    if (document.activeElement === document.body && st.note) { /* keep the keyboard closed */ }
  }

  paint();
  // Asked once: a page drawn again (Android makes a new window for a theme
  // change) does not open the camera or the microphone a second time.
  if (want) history.replaceState(null, '', `#/fb/${encodeURIComponent(id)}`);
  if (want === 'photo' && !st.drops.length) void photo();
  if (want === 'voice' && st.recording === null && !st.drops.some((d) => d.kind === 'voice')) void startVoice();
  return {
    el,
    // The screen is the person's: a new board state draws it again only
    // until its checkpoint and session are known.
    update: () => { if (!seen && cpNow()) { seen = true; paint(); } },
    dispose: () => {
      disposed = true;
      if (timer) clearInterval(timer);
      if (st.recording !== null) { void sh.call('voice.cancel').catch(() => {}); st.recording = null; }
    },
  };
}
