// The OpenAI Codex adapter (docs/ASSISTANTS.md), reached only through
// server/assistant.mjs. Stage 1: the board watches Codex sessions (state from
// Codex's hooks, the screen, the transcript) and replies to them (a message,
// a menu's option). What only Claude Code has (its suggested reply, the
// pictures a session showed, background tasks, process memory, recaps) is
// not shown for a Codex session.
//
// Codex's terminal interface, measured on Codex 0.166.0 in cmux 0.64.20
// (captured screens in tools/fixtures/codex/; the rules in
// docs/STATE-RULES.md, "Codex's screen"). It runs on the alternate screen,
// so a read holds the visible screen only:
//
//   › Reply with exactly the word: pong          a prompt you sent (history)
//   • pong                                       Codex's answer
//     Worked for 1s • 12:04                      the done line
//   • Working (4s • esc to interrupt) · ...      the spinner, while it works
//
//   › Ask Codex to do anything                   the composer: "›" and the
//                                                text, a dim placeholder
//                                                when empty, "!" in shell mode
//     GPT-5.6-Luna low · ~/folder · Thread name  the footer: model, folder,
//     ← for agents · ? for shortcuts             thread, then hints
//
// A menu (a command's approval, the folder-trust prompt, a question)
// replaces the composer: numbered options with "›" on the selected one and
// a hint line such as "Press enter to confirm or esc to cancel". On exit the
// shell prints "To continue this session, run: codex resume <id>" (or, with
// Codex's app-server daemon, "Disconnected from this task." and "To
// reconnect, run:").

import * as term from './terminal.mjs';
import { isShellLine } from './screen.mjs';
import { readRollout, findRollout, firstPrompt as rolloutFirstPrompt } from './codexrollout.mjs';

export const KIND = 'codex';
export const NAME = 'Codex';
export const SHORT = 'Codex';
export const RULES_FILE = 'AGENTS.md';
export const SUPPORTS = {
  suggestion: false,
  pictures: false,
  backgroundTasks: false,
  processes: false,
  recap: false,
  handoff: true,
  codeSpans: false,
};
export const CMUX_AGENT = 'codex';

// The composer's dim placeholders (codex-rs/tui chatwidget.rs, 0.166.0):
// fixed text, so a plain read can tell them from typed text.
const PLACEHOLDERS = new Set(['Ask Codex to do anything', 'Ask a follow-up question']);
const MARKER = /^([›!])(?:\s(.*))?$/;
// A footer line of Codex's: the model line or a hint line.
const FOOTER_SIGN = /( · |for shortcuts|to queue message|Shell mode|esc to interrupt|to view|context left)/;
// A menu's hint line (the approval, the folder trust, a question).
const DIALOG_HINTS = [
  /Press enter to confirm or esc to cancel/i,
  /enter to confirm/i,
  /enter to submit/i,
  /^\s*enter continue · esc/i,
];
const OPTION = /^\s*(›)?\s*(\d+)\.\s+(.+?)\s*$/;
// What Codex prints in the shell when it exits.
const EXIT_LINES = [/^To continue this session, run:/, /^Disconnected from this task\./, /^To reconnect, run:/];
const DONE_LINE = /^\s*(Worked) for (.+?)\s+•\s+(.+?)\s*$/;
const BUSY = /esc to interrupt/i;
const UUID = /codex resume ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;

function trimLines(text) {
  return String(text || '').replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, ''));
}

// The composer nearest the bottom: { at, end, footer, draft } or null.
// From the bottom: the footer (1 to 4 indented lines, one of them Codex's),
// the composer's blank bottom row, then the "›" (or "!") line and its
// indented continuation lines.
function findComposer(lines) {
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  let f = end;
  while (f > 0 && lines[f - 1].trim() && /^\s/.test(lines[f - 1]) && end - f < 4) f--;
  if (f === end || !lines.slice(f, end).some((l) => FOOTER_SIGN.test(l))) return null;
  let k = f;
  while (k > 0 && !lines[k - 1].trim()) k--;
  if (k === f) return null;
  let m = k - 1;
  while (m >= 0 && /^ {2}\S/.test(lines[m])) m--;
  if (m < 0) return null;
  const mm = MARKER.exec(lines[m]);
  if (!mm) return null;
  const text = [mm[2] || '', ...lines.slice(m + 1, k).map((l) => l.replace(/^ {2}/, ''))].join('\n').trim();
  let draft = PLACEHOLDERS.has(text) ? '' : text;
  if (mm[1] === '!') draft = text ? '! ' + text : '!';
  return { at: m, end: k, footer: lines.slice(f, end), draft, shell: mm[1] === '!' };
}

// The open menu: { at, zone } where at is its hint line, or null.
function findDialog(lines) {
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  for (let i = end - 1; i >= Math.max(0, end - 30); i--) {
    if (DIALOG_HINTS.some((re) => re.test(lines[i]))) return i;
  }
  return -1;
}

function readDialog(lines, at) {
  const zone = lines.slice(Math.max(0, at - 20), at + 1);
  const options = [];
  let last = null;
  for (const l of zone) {
    const m = l.match(OPTION);
    if (m) { last = { n: Number(m[2]), label: m[3], selected: !!m[1], indent: l.search(/\d/) }; options.push(last); continue; }
    // A long option wraps onto lines indented past its number.
    if (last && l.trim() && l.search(/\S/) > last.indent) { last.label += ' ' + l.trim(); continue; }
    last = null;
  }
  const first = zone.findIndex((l) => OPTION.test(l));
  const above = first >= 0 ? zone.slice(0, first) : zone;
  // The question: the last line above the options that ends with "?",
  // with the lines it wrapped from ("Reason: ... outside the writable" /
  // "root?").
  let qi = -1;
  for (let i = above.length - 1; i >= 0; i--) if (/\?\s*$/.test(above[i].trim())) { qi = i; break; }
  let question = null;
  if (qi >= 0) {
    let a = qi;
    while (a > 0 && above[a - 1].trim() && !/^\s*\$ /.test(above[a - 1])) a--;
    question = above.slice(a, qi + 1).map((l) => l.trim()).join(' ');
  }
  return {
    question,
    options: options.map(({ n, label, selected }) => ({ n, label, selected })),
    lines: zone.filter((l) => l.trim()).map((l) => l.trim()),
  };
}

// What a Codex screen shows, in Claude Code's shape (server/screen.mjs
// parseScreen): claudeLive means Codex's interface is live in the tab.
export function parseScreen(text) {
  const lines = trimLines(text);
  const out = {
    readable: text != null,
    claudeLive: false, shell: false, exited: false,
    working: false, busyLine: null,
    done: null, recap: null,
    draft: '', dialog: null,
    agentsRunning: 0,
    resumeId: null,
    body: [], footer: [],
  };
  if (text == null) return out;
  const rm = [...String(text).matchAll(UUID)].pop();
  if (rm) out.resumeId = rm[1];

  let lastShell = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (isShellLine(lines[i])) { lastShell = i; break; }
  const exitAt = lines.findIndex((l) => EXIT_LINES.some((re) => re.test(l)));
  const box = findComposer(lines);
  const dialogAt = findDialog(lines);
  const dialogLive = dialogAt >= 0 && (!box || dialogAt > box.at);

  if (box && lastShell < box.at) out.claudeLive = true;
  else if (dialogLive && lastShell < dialogAt) out.claudeLive = true;
  else if (lastShell >= 0) {
    out.shell = true;
    out.exited = exitAt >= 0 && exitAt < lastShell; // Codex printed its exit lines, then the shell took the tab
  }
  if (!out.claudeLive) {
    out.body = lines.filter((l) => l.trim()).slice(-12);
    return out;
  }

  const stop = dialogLive ? Math.max(0, dialogAt - 20) : box.at;
  const above = lines.slice(0, stop);
  out.footer = box && !dialogLive ? box.footer : [];
  if (box && !dialogLive) out.draft = box.draft;
  if (dialogLive) out.dialog = readDialog(lines, dialogAt);

  // The spinner: "• Working (4s • esc to interrupt) · 1 background terminal running".
  const near = above.slice(-8);
  for (let i = near.length - 1; i >= 0; i--) {
    if (DONE_LINE.test(near[i])) break;
    if (BUSY.test(near[i])) { out.working = true; out.busyLine = near[i].trim().replace(/^•\s+/, '').split(' · ')[0]; break; }
  }
  for (let i = above.length - 1; i >= Math.max(0, above.length - 40); i--) {
    const m = above[i].match(DONE_LINE);
    if (m) { out.done = { verb: m[1], took: m[2].trim(), when: m[3].trim(), extra: null }; break; }
  }
  out.body = above.filter((l) => l.trim()).slice(-12);
  return out;
}

// Codex titles its tab (measured in cmux): "<thread> | <folder>" at rest
// ("<folder>" alone before the first prompt), a braille spinner glyph in
// front while it works ("⠙ Reply with board-ok | work"), and "[ ! ] Action
// Required | " in front while an approval waits. `claude` means the title is
// this assistant's, as for Claude Code's "✳ Topic".
const SPIN = /^([\u2801-\u28ff])\s+/u;
const ACTION = /^\[ ! \] Action Required \| /;
export function parseTitle(title) {
  let t = String(title || '');
  const spin = t.match(SPIN);
  if (spin) t = t.slice(spin[0].length);
  const action = ACTION.test(t);
  if (action) t = t.replace(ACTION, '');
  const parts = t.split(' | ');
  const mine = !!spin || action || parts.length > 1;
  if (!mine) return { claude: false, busy: false, topic: null };
  return { claude: true, busy: !!spin, glyph: spin ? spin[1] : null, topic: parts.length > 1 ? parts.slice(0, -1).join(' | ').trim() || null : null };
}

// ------------------------------------------------------------ the live screen

// "• Ran sleep 12", "• You ran echo hi", "• Exited (status 1) touch x":
// a tool call. Anything else after "• " is Codex's text.
const TOOL = /^• (You ran|Ran|Running|Exited \(status \d+\)|Explored|Exploring|Read|Reading|Searched|Searching|Listed|Edited|Editing|Added|Deleted|Updated Plan|Called|Calling|Waited|Waiting|Blocked by hook)(?=\s|$)\s*(.*)$/;

// The screen as the Live screen's entries (server/screen.mjs trimScreen
// lists the kinds): the composer, the footer and the spinner are removed,
// each tool call is one line with its output's line count, and a line Codex
// wrapped at the terminal's width is joined to the next.
export function trimScreen(text) {
  const lines = trimLines(text);
  const ps = parseScreen(text);
  const out = { live: ps.claudeLive, width: 0, entries: [], status: null };
  if (text == null) return out;
  out.width = Math.max(0, ...lines.map((l) => Array.from(l).length));
  const W = out.width;
  if (!ps.claudeLive) {
    const l = lines.filter((x, i, a) => x.trim() || (i > 0 && a[i - 1].trim()));
    while (l.length && !l[l.length - 1].trim()) l.pop();
    if (l.length) out.entries.push({ k: 'p', l });
    return out;
  }
  const box = findComposer(lines);
  const dialogAt = findDialog(lines);
  const dialogLive = dialogAt >= 0 && (!box || dialogAt > box.at);
  const above = lines.slice(0, dialogLive ? lines.length : box.at);
  const entries = [];
  let cur = null;
  const push = (e) => { entries.push(e); cur = e; return e; };
  const addLine = (e, raw, t) => {
    // Wrapped at the terminal's width: the next line goes on the same one.
    if (e.wrap && e.l.length) e.l[e.l.length - 1] += ' ' + t; else e.l.push(t);
    e.wrap = Array.from(raw).length >= W - 2;
  };
  for (const l of above) {
    if (!l.trim()) { if (cur && cur.l) cur.wrap = false; if (cur && cur.k === 't') cur = null; continue; }
    let m;
    if (BUSY.test(l) && /^•\s/.test(l)) { cur = null; continue; }
    if ((m = l.match(DONE_LINE))) { push({ k: 's', g: '•', t: l.trim() }); cur = null; continue; }
    if ((m = l.match(TOOL))) { push({ k: 't', n: m[1], a: m[2] || '', m: 0 }); continue; }
    if (/^› /.test(l)) { const e = push({ k: 'u', l: [] }); addLine(e, l, l.slice(2)); continue; }
    if (/^• /.test(l)) { const e = push({ k: 'c', l: [] }); addLine(e, l, l.slice(2)); continue; }
    if (/^■ /.test(l)) { push({ k: 'o', t: l.slice(2).trim() }); cur = null; continue; }
    if (/^\s+└(\s|$)/.test(l) || (cur && cur.k === 't' && /^\s{4,}\S/.test(l))) {
      if (cur && cur.k === 't') {
        // The tool's output: "+ 2 lines (⌃t to expand)" stands for lines not shown.
        const body = l.replace(/^\s+└?\s?/, '').trim();
        const hidden = body.match(/^\+ (\d+) lines?\b/);
        if (hidden) cur.m += Number(hidden[1]);
        else if (body && body !== '(no output)') cur.m++;
      }
      continue; // a note under Codex's text ("└ Tip: ...")
    }
    if (/^ {2}\S/.test(l) && cur && cur.l && cur.k !== 'p') { addLine(cur, l, l.slice(2)); continue; }
    if (cur && cur.k === 'p') { cur.l.push(l); continue; }
    push({ k: 'p', l: [l] });
  }
  for (const e of entries) {
    if (e.l) { const x = { k: e.k, l: e.l }; if (x.l.length) out.entries.push(x); continue; }
    out.entries.push(e);
  }
  if (dialogLive) out.entries.push({ k: 'p', l: lines.slice(Math.max(0, dialogAt - 20), dialogAt + 1).filter((x) => x.trim()) });
  out.status = { busy: ps.busyLine, agents: [], done: ps.done };
  return out;
}

// ------------------------------------------------------------ the prompt

// Codex shows no suggested reply, and its placeholder is known text, so a
// plain read is enough: anything else in the composer is typed text.
export async function judgeRead(tab, screen) {
  const text = screen.claudeLive ? screen.draft : '';
  return text ? { text, kind: 'draft', sure: true, by: 'screen' } : { text: '', kind: 'empty', sure: true, by: 'screen' };
}

export function judgedScreen(x) {
  const screen = parseScreen(x ? x.text : null);
  return { ...screen, suggestion: null, prompt: screen.draft ? { kind: 'draft', sure: true, by: 'screen' } : { kind: 'empty', sure: true, by: 'screen' } };
}

export function forget() {}

export async function surePrompt(tab, screen) {
  return screen.draft ? { kind: 'draft', sure: true, by: 'screen' } : { kind: 'empty', sure: true, by: 'screen' };
}
export const withPrompt = (screen) => screen;

// Text in the composer before a send is typed text: never mixed in.
export async function checkPrompt(tab, screen, { choice, where }) {
  if (choice != null && !screen.dialog) return { ok: false, status: 409, error: 'No choice is open on screen any more, so nothing was pressed.' };
  return { ok: false, status: 409, error: `There is half-typed text in its prompt. Finish it in ${where} so it is not mixed in.` };
}

// Smart punctuation back to what a shell expects (as for Claude Code).
function plainCommand(s) {
  return String(s)
    .replace(/—/g, '--').replace(/–/g, '-')
    .replace(/[“”„«»]/g, '"').replace(/[‘’‚]/g, "'")
    .replace(/ /g, ' ');
}

// A paste then Enter. A "! command" goes the same way: in Codex a pasted "!"
// turns on its shell mode as a typed one does (measured), so only the
// command's punctuation is put back. While Codex works, Enter hands the
// message to the running turn (Tab would queue it instead).
export async function typeMessage(tab, msg, { where }) {
  const bang = /^!\s*/.exec(msg);
  if (bang && msg.length > bang[0].length) msg = '!' + plainCommand(msg.slice(bang[0].length));
  const a = await term.pasteText(tab, msg);
  if (!a.ok) return { ok: false, status: 500, error: a.err || `${where} refused the text.` };
  await new Promise((r) => setTimeout(r, 150));
  const b = await term.pressKey(tab, 'enter');
  if (!b.ok) return { ok: false, status: 500, error: b.err || `${where} refused Enter.` };
  return { ok: true };
}

// ------------------------------------------------------------ transcripts

export const findTranscript = (sessionId) => findRollout(sessionId);
// Rollouts are filed by date, not by folder, so there is no folder guess.
export const newestTranscriptFor = () => null;
export const readTranscript = (file) => readRollout(file);
// The repo comes from the hook's cwd: a rollout's tool calls are scripts.
export const workFolder = () => null;
export const firstPrompt = (file) => rolloutFirstPrompt(file);
export const launchCommand = (settings) => (settings && settings.codexCommand) || 'codex';
