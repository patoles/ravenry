// The checkpoint cards at the top of the session panel, drawn as picked
// (variant A of each, docs in the private design notes): a question with
// one answer per line and number keys, a command with its folder, machine
// and pane on labelled lines, and a secret typed into a field in the card.
// Then what each says once it closed.
//
// A card is built once per checkpoint and state and kept, so a new board
// state never rebuilds it under the person's hands: the field they type in
// keeps its focus and text. Only the times in it are refreshed.

import type { CheckpointReply } from '@ravenry/client';
import { h, svg } from './dom.ts';
import * as I from './icons.ts';
import {
  afterOf, changedRange, whoMid, characters, digitChoice, givesUp, heading, isOpen, isRemote, kindOf, machineLine, runLabel, SecretField, splitTitle, waiting, warningsOf, who,
} from './checkpoints.ts';
import type { HubCheckpoint, Known } from './checkpoints.ts';

/** An answer: an approval may carry the command as the person edited it, a refusal its reason. */
export type Reply = CheckpointReply;

export interface CardCtx {
  now(): number;
  platform: string;
  /** The folder as people read it (~ for home). */
  tilde(p: string | undefined): string;
  /** True when the phone was alerted too (the hub lists it and its alerts are on). */
  phoneToo(k: Known): boolean;
  /** The pane the asking agent runs in, for people ("Old recipe import", "zsh"). */
  paneName(k: Known): string;
  /**
   * False when the daemon or the hub does not take this window as the
   * person (it was started from inside a pane): the card shows, its
   * buttons do not work, and NOT_PERSON says why.
   */
  canAnswer(k: Known): boolean;
  /** Answers; rejects with words for people, or with a NotPerson error. */
  answer(k: Known, reply: Reply): Promise<void>;
  /** Shows the pane an approved command ran in, when this window can. */
  showRun(k: Known): (() => void) | null;
  /** The card was answered from the keyboard or a button: a narrow window goes back to the terminal. */
  answered(): void;
}

/** What a card says when the window may not answer (PROTOCOL.md section 4, Who acts as the person). */
export const NOT_PERSON = 'Answers only work from the Ravenry app when it is opened normally. This window was started from inside a terminal pane.';

/** The daemon or the hub refused this window as the person. */
export class NotPerson extends Error {
  constructor() { super(NOT_PERSON); this.name = 'NotPerson'; }
}

interface UI { editing: boolean; edit: string; refusing: boolean; reason: string; busy: boolean; error: string | null; draft: string; reveal: boolean }

interface View {
  key: string;
  el: HTMLElement;
  refresh(): void;
  /** Where the keyboard goes when the card is opened from its row. */
  focus(): void;
  secret?: SecretField;
}

const views = new Map<string, View>();
const uis = new Map<string, UI>();

function ui(id: string): UI {
  let u = uis.get(id);
  if (!u) { u = { editing: false, edit: '', refusing: false, reason: '', busy: false, error: null, draft: '', reveal: false }; uis.set(id, u); }
  return u;
}

let stamp = 0;
/** Something on a card changed (busy, an error, editing): it is built again on the next render. */
let onChange: () => void = () => {};
export function onCardChange(fn: () => void): void { onChange = fn; }
function changed(id: string): void { stamp++; const v = views.get(id); if (v) v.key = ''; onChange(); }

/** The card for a checkpoint, built once per state and kept. */
export function cardFor(k: Known, ctx: CardCtx): HTMLElement {
  const u = ui(k.cp.id);
  // A page's run (the hub's word on it can come after the daemon's) changes the heading.
  const key = `${k.cp.state}|${u.editing}|${u.refusing}|${u.busy}|${u.error}|${ctx.canAnswer(k)}|${!!(k.cp as HubCheckpoint).page}`;
  const had = views.get(k.cp.id);
  if (had && had.key === key) { had.refresh(); return had.el; }
  had?.secret?.clear();
  const v = isOpen(k.cp) && k.cp.state === 'open' ? openCard(k, ctx, u) : afterCard(k, ctx);
  v.key = key;
  views.set(k.cp.id, v);
  return v.el;
}

/** Puts the keyboard in the card: the secret's field, else the card itself (number keys answer). */
export function focusCard(id: string): void {
  views.get(id)?.focus();
}

/**
 * A secret's card that left the panel, or a panel that is hidden: what was
 * typed there goes, as on a blur (a card taken out of the page gets none).
 */
export function clearHiddenSecrets(panelShown: boolean): void {
  for (const v of views.values()) if (v.secret && (!panelShown || !v.el.isConnected)) v.secret.clear();
}

/** Forgets cards of checkpoints the window no longer knows. */
export function pruneCards(ids: Set<string>): void {
  for (const id of [...views.keys()]) if (!ids.has(id)) { views.get(id)?.secret?.clear(); views.delete(id); uis.delete(id); }
}

/** A number key, typed while a question's card has the keyboard: its answer. */
export function cardKey(k: Known, e: KeyboardEvent, ctx: CardCtx): boolean {
  const i = digitChoice(e.key, k.cp);
  if (i === null || e.metaKey || e.ctrlKey || e.altKey || !ctx.canAnswer(k)) return false;
  void send(k, ctx, { choice: i });
  return true;
}

async function send(k: Known, ctx: CardCtx, reply: Reply): Promise<void> {
  const u = ui(k.cp.id);
  if (u.busy || !ctx.canAnswer(k)) return;
  u.busy = true;
  u.error = null;
  changed(k.cp.id);
  try {
    await ctx.answer(k, reply);
    u.editing = false;
    u.refusing = false;
    u.reason = '';
    u.draft = '';
    ctx.answered();
  } catch (e) {
    // A refusal as the person shows as the card's one line, not as an error.
    u.error = e instanceof NotPerson ? null : (e as Error).message || String(e);
  } finally {
    u.busy = false;
    changed(k.cp.id);
  }
}

// ---------------------------------------------------------------- open cards

function header(k: Known, ctx: CardCtx, icon: string): { el: HTMLElement; refresh(): void } {
  const when = h('span.t3.num', waiting(k.cp, ctx.now()));
  return { el: h('div.cp-h', h('span.kd', svg(icon)), heading(k.cp), h('span.sp'), when), refresh: () => { when.textContent = waiting(k.cp, ctx.now()); } };
}

function footer(k: Known, ctx: CardCtx): { el: HTMLElement; refresh(): void } {
  const until = h('span.num', givesUp(k.cp, ctx.now()));
  const phone = h('span.ph', svg(I.PHONE_S), 'On your phone too');
  const refresh = () => {
    until.textContent = givesUp(k.cp, ctx.now());
    phone.hidden = !ctx.phoneToo(k);
  };
  refresh();
  return { el: h('div.cp-f', phone, h('span.sp'), until), refresh };
}

function errorLine(u: UI, k?: Known, ctx?: CardCtx): HTMLElement | null {
  if (k && ctx && !ctx.canAnswer(k)) return h('p.cp-np', { role: 'note' }, NOT_PERSON);
  return u.error ? h('p.cp-err', { role: 'alert' }, u.error) : null;
}

function openCard(k: Known, ctx: CardCtx, u: UI): View {
  switch (kindOf(k.cp)) {
    case 'ask': return askCard(k, ctx, u);
    case 'approve': return approveCard(k, ctx, u);
    case 'secret': return secretCard(k, ctx, u);
    default: return otherCard(k, ctx, u);
  }
}

function askCard(k: Known, ctx: CardCtx, u: UI): View {
  const off = u.busy || !ctx.canAnswer(k);
  const cp = k.cp;
  const { head, body } = splitTitle(cp.title);
  const hd = header(k, ctx, I.ASK);
  const ft = footer(k, ctx);
  const opts = (cp.options || []).map((o, i) => h('button.btn.opt', { disabled: off, on: { click: () => void send(k, ctx, { choice: i }) } },
    i < 9 ? h('span.kb', String(i + 1)) : null, h('span.ol', o)));
  let field: HTMLTextAreaElement | null = null;
  let fieldBox: HTMLElement | null = null;
  if (cp.free_text) {
    const go = h('button.snd', { title: 'Send (Enter)', 'aria-label': 'Send your answer', disabled: off, on: { click: () => sendText() } }, svg(I.SEND));
    field = h('textarea.fi', { rows: '1', placeholder: 'Or answer in your own words', 'aria-label': 'Your answer', spellcheck: 'true', disabled: off }) as HTMLTextAreaElement;
    field.value = u.draft;
    const fit = () => {
      field!.style.height = 'auto';
      field!.style.height = `${Math.min(field!.scrollHeight, 120)}px`;
      go.classList.toggle('go', !!field!.value.trim());
      fieldBox!.classList.toggle('typed', !!field!.value);
    };
    field.addEventListener('input', () => { u.draft = field!.value; fit(); });
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendText(); }
      e.stopPropagation();
    });
    fieldBox = h('div.fld', field, go);
    requestAnimationFrame(fit);
  }
  function sendText(): void {
    const t = (field?.value || '').trim();
    if (!t) { field?.focus(); return; }
    void send(k, ctx, { text: t.slice(0, 4096) });
  }
  const el = h('div.sec.ask.cp', { tabindex: '-1', 'data-cp': cp.id, 'aria-label': `${heading(cp)}: ${head}`, on: { keydown: (e: Event) => { if (cardKey(k, e as KeyboardEvent, ctx)) { e.preventDefault(); e.stopPropagation(); } } } },
    hd.el,
    h('div.cp-q', head),
    body ? h('p.cp-d', body) : null,
    opts.length ? h('div.opts', opts) : null,
    fieldBox,
    errorLine(u, k, ctx),
    ft.el);
  return {
    key: '', el,
    refresh: () => { hd.refresh(); ft.refresh(); },
    focus: () => { if (!opts.length && field) field.focus(); else el.focus(); },
  };
}

/**
 * Refuse, with a reason if the person types one (the picture's note: Refuse
 * sends "refused", with a reason if you type one). The first click opens a
 * one-line field under the card's words; Enter or Refuse sends, with or
 * without text; Escape or Back closes it.
 */
function refuseRow(k: Known, ctx: CardCtx, u: UI, off: boolean): { els: (HTMLElement | null)[]; field: HTMLInputElement } {
  const cp = k.cp;
  const field = h('input.fi.rsn', { type: 'text', placeholder: `Why not? Optional, ${whoMid(cp)} reads it`, 'aria-label': `Why you refuse, for ${whoMid(cp)}`, maxlength: '1000', spellcheck: 'true', disabled: off }) as HTMLInputElement;
  field.value = u.reason;
  const go = (): void => { const r = field.value.trim(); void send(k, ctx, r ? { decline: true, reason: r } : { decline: true }); };
  field.addEventListener('input', () => { u.reason = field.value; });
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); u.refusing = false; changed(cp.id); return; }
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); go(); }
    e.stopPropagation();
  });
  return {
    field,
    els: [
      h('div.fld.rsn-f', field),
      h('div.qa',
        h('button.btn.sm.no', { disabled: off, on: { click: () => go() } }, 'Refuse'),
        h('button.btn.sm', { disabled: off, on: { click: () => { u.refusing = false; changed(cp.id); } } }, 'Back')),
      errorLine(u, k, ctx),
      h('div.cp-f', `${who(cp)} is told you said no, with your reason if you give one.`),
    ],
  };
}

/** The card's Refuse button: it opens the reason field. */
function refuseButton(k: Known, u: UI, off: boolean, cls = 'button.btn.sm.ghost.no'): HTMLElement {
  return h(cls, { disabled: off, on: { click: () => { u.refusing = true; u.editing = false; u.error = null; changed(k.cp.id); requestAnimationFrame(() => focusCard(k.cp.id)); } } }, 'Refuse');
}

function approveCard(k: Known, ctx: CardCtx, u: UI): View {
  const off = u.busy || !ctx.canAnswer(k);
  const cp = k.cp;
  const command = cp.command || '';
  const w = who(cp);
  const hd = header(k, ctx, I.RUN);
  const ft = footer(k, ctx);
  const remote = isRemote(cp.machine);
  // The agent's own warning and Ravenry's guess, each labelled as whose.
  const warnings = warningsOf(cp, u.editing ? u.edit : command);
  const kv = h('div.kv',
    h('span', 'Folder'), h('span.mono', ctx.tilde(cp.cwd)),
    h('span', 'Machine'), h('span', remote ? h('span.mt', svg(I.MACHINE), cp.machine!) : machineLine(cp.machine, ctx.platform)),
    h('span', 'Pane'), h('span', cp.pane ? `A new one, beside ${ctx.paneName(k)}` : 'A new one'),
    // A page's run button passes the item's values as variables: shown as
    // they are, never inside the command.
    Object.entries(cp.env || {}).map(([name, value]) => [h('span.mono', name), h('span.mono', value)]));
  let box: HTMLElement;
  let editor: HTMLTextAreaElement | null = null;
  if (u.editing) {
    // The field over a copy of its text that tints what was changed.
    const hl = h('pre.cmdb.edit', { 'aria-hidden': 'true' });
    editor = h('textarea.cmd-in', { spellcheck: 'false', 'aria-label': 'The command to run', disabled: off }) as HTMLTextAreaElement;
    editor.value = u.edit;
    const tint = () => {
      const v = editor!.value;
      u.edit = v;
      const r = changedRange(command, v);
      hl.textContent = '';
      if (!r) hl.append(v);
      else hl.append(v.slice(0, r[0]), h('span.chg', v.slice(r[0], r[1]) || '​'), v.slice(r[1]));
      hl.append('\n');
    };
    editor.addEventListener('input', tint);
    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); u.editing = false; changed(cp.id); return; }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runEdited(); }
      e.stopPropagation();
    });
    tint();
    box = h('div.cmd-edit', hl, editor);
  } else {
    box = h('pre.cmdb', command);
  }
  function runEdited(): void {
    const v = (editor?.value || '').replace(/\s+$/, '');
    if (!v.trim()) { editor?.focus(); return; }
    void send(k, ctx, v === command ? { approve: true } : { approve: true, command: v });
  }
  const refuse = u.refusing && !u.editing ? refuseRow(k, ctx, u, off) : null;
  const buttons = refuse ? refuse.els : u.editing
    ? [h('div.qa',
      h('button.btn.sm.pri', { disabled: off, on: { click: () => runEdited() } }, 'Run edited command'),
      h('button.btn.sm', { disabled: off, on: { click: () => { u.editing = false; changed(cp.id); } } }, 'Cancel')),
    errorLine(u, k, ctx),
    h('div.cp-f', `${w} is told you changed it.`)]
    : [h('div.qa',
      h('button.btn.sm.pri', { disabled: off, on: { click: () => void send(k, ctx, { approve: true }) } }, runLabel(cp.machine, ctx.platform)),
      h('button.btn.sm', { disabled: off, on: { click: () => { u.editing = true; u.edit = command; u.error = null; changed(cp.id); requestAnimationFrame(() => focusCard(cp.id)); } } }, 'Edit'),
      refuseButton(k, u, off)),
    errorLine(u, k, ctx),
    ft.el];
  const el = h('div.sec.ask.cp', { tabindex: '-1', 'data-cp': cp.id, 'aria-label': `${heading(cp)}: ${command}` },
    hd.el, box, kv,
    ...warnings.map((x) => h(`div.risk.${x.from}`, svg(I.WARN), h('span', h('span.wl', x.label), ' ', x.text))),
    cp.why ? h('p.says', h('span', `${w} says:`), ' ', cp.why) : null,
    buttons);
  return {
    key: '', el,
    refresh: () => { hd.refresh(); ft.refresh(); },
    focus: () => {
      if (editor) { editor.focus(); editor.setSelectionRange(editor.value.length, editor.value.length); } else if (refuse) refuse.field.focus(); else el.focus();
    },
  };
}

function secretNoun(title: string): string {
  if (/\btoken\b/i.test(title)) return 'token';
  if (/\bpassword\b|\bpassphrase\b/i.test(title)) return 'password';
  if (/\bkey\b/i.test(title)) return 'key';
  return 'secret';
}

function secretCard(k: Known, ctx: CardCtx, u: UI): View {
  const off = u.busy || !ctx.canAnswer(k);
  const cp = k.cp;
  const w = who(cp);
  const { head } = splitTitle(cp.title);
  const hd = header(k, ctx, I.KEY);
  const ft = footer(k, ctx);
  const toPane = cp.secret?.to === 'input';
  const input = h('input.si', {
    type: u.reveal ? 'text' : 'password', placeholder: `Paste or type the ${secretNoun(cp.title)}`, 'aria-label': head,
    autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'data-secret': '1', disabled: off,
  }) as HTMLInputElement;
  const count = h('span.t3.num.cnt-c');
  // Pressed with nothing typed yet, it puts the cursor in the field.
  const go = h('button.btn.sm.pri', { disabled: off, on: { click: () => sendSecret() } }, 'Send to the terminal');
  const box = h('div.sfld', input, count,
    h('button.eye', { title: u.reveal ? 'Hide it' : 'Show it', 'aria-label': u.reveal ? 'Hide the secret' : 'Show the secret', on: { mousedown: (e: Event) => e.preventDefault(), click: () => { u.reveal = !u.reveal; input.type = u.reveal ? 'text' : 'password'; eye.replaceChildren(svg(u.reveal ? I.EYE_OFF : I.EYE)); input.focus(); } } }));
  const eye = box.lastElementChild as HTMLElement;
  eye.append(svg(u.reveal ? I.EYE_OFF : I.EYE));
  const field = new SecretField(input, () => {
    const n = field.count;
    count.textContent = n ? characters(n) : '';
    box.classList.toggle('typed', n > 0);

  });
  input.addEventListener('focus', () => box.classList.add('on'));
  input.addEventListener('blur', () => box.classList.remove('on'));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendSecret(); }
    e.stopPropagation();
  });
  function sendSecret(): void {
    if (field.problem) { input.focus(); return; }
    // The only place the secret leaves the field: straight into the answer call.
    void send(k, ctx, { secret: field.take() });
  }
  const forLine = toPane
    ? h('p.cp-d', 'Typed into ', h('b', ctx.paneName({ ...k, cp: { ...cp, pane: cp.secret?.pane } })), ', the program waiting there')
    : h('p.cp-d', 'For ', h('span.mono.code', cp.command || ''), cp.cwd ? ` in ${ctx.tilde(cp.cwd)}` : '', cp.secret?.to === 'env' && cp.secret.env ? `, as $${cp.secret.env}` : '');
  const el = h('div.sec.ask.cp', { tabindex: '-1', 'data-cp': cp.id, 'aria-label': `${heading(cp)}: ${head}` },
    hd.el,
    h('div.cp-q', head),
    forLine,
    box,
    h('ul.prom',
      h('li', svg(I.LOCK), toPane ? `Goes straight to that program, not to ${whoMid(cp)}` : `Goes straight to that command, not to ${whoMid(cp)}`),
      h('li', svg(I.LOCK), 'Not kept in logs, history or on your phone')),
    h('div.qa', go, h('button.btn.sm.ghost', { disabled: off, on: { mousedown: (e: Event) => e.preventDefault(), click: () => { field.clear(); void send(k, ctx, { decline: true }); } } }, 'Not now')),
    errorLine(u, k, ctx),
    ft.el);
  // The send button must not take the focus (and so clear the field) before its click.
  go.addEventListener('mousedown', (e) => e.preventDefault());
  return {
    key: '', el, secret: field,
    refresh: () => { hd.refresh(); ft.refresh(); },
    focus: () => input.focus(),
  };
}

function otherCard(k: Known, ctx: CardCtx, u: UI): View {
  const off = u.busy || !ctx.canAnswer(k);
  const hd = header(k, ctx, I.ASK);
  const ft = footer(k, ctx);
  const { head, body } = splitTitle(k.cp.title);
  const refuse = u.refusing ? refuseRow(k, ctx, u, off) : null;
  const el = h('div.sec.ask.cp', { tabindex: '-1', 'data-cp': k.cp.id },
    hd.el, h('div.cp-q', head), body ? h('p.cp-d', body) : null,
    h('p.cp-d', 'This version of Ravenry does not know this kind of question. You can only refuse it.'),
    ...(refuse ? refuse.els : [h('div.qa', refuseButton(k, u, off)), errorLine(u, k, ctx), ft.el]));
  return { key: '', el, refresh: () => { hd.refresh(); ft.refresh(); }, focus: () => (refuse ? refuse.field.focus() : el.focus()) };
}

// ---------------------------------------------------------------- after

function afterCard(k: Known, ctx: CardCtx): View {
  const a = afterOf(k.cp, ctx.now(), ctx.platform);
  const show = a.runPane ? ctx.showRun(k) : null;
  const el = h('div.sec.cp.after', { 'data-cp': k.cp.id },
    h(`div.cp-h${a.ok ? '.ok' : '.no'}`, h('span.kd', svg(a.ok ? I.DONE : I.ENDED)), a.head, h('span.sp'), h('span.t3.num', a.time)),
    a.small ? h('div.done-q', a.small) : null,
    a.big ? h('div.cp-q', a.big) : null,
    a.command ? h('pre.cmdb.muted', a.command) : null,
    h('p.cp-d', a.text),
    show ? h('button.lk.self', { on: { click: show } }, 'Show in the terminal') : null);
  return { key: '', el, refresh: () => {}, focus: () => {} };
}
