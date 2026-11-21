// OpenCode's adapter (docs/ASSISTANTS.md, "OpenCode"), measured on
// OpenCode 1.19.6 (opencode-ai on npm). Its state comes from Ravenry's
// plugin (hooks/opencode-plugin.js), which reports through `ravenryd hook
// --state` like the stand-in; this adapter adds what the board reads of its
// screen and the plugin's session file:
//
//   the screen      its full-screen interface: the prompt box's bottom edge
//                   (a row of ▀ under a ╹) with "ctrl+p commands" below it,
//                   "esc interrupt" there while a turn runs, and a
//                   permission prompt ("△ Permission required", then "Allow
//                   once   Allow always   Reject") in place of the box
//   a permission    answered from the board through OpenCode's own API: the
//                   plugin waits on the hub (a PermissionWait report the hub
//                   decides), and the answer the board gives here goes to it
//                   as "once", "always" or "reject"; no key is pressed
//   the transcript  the plugin's JSON file per session (model, context in
//                   use and the model's window, last message, prompts),
//                   under <XDG_STATE_HOME or ~/.local/state>/ravenry/opencode
//   its models      `opencode models` (provider/model, OpenRouter's among
//                   them once OpenCode has its key), read at most every 10
//                   minutes, in the background

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import * as hookonly from './hookonly.mjs';
import { findBin } from './assistantfind.mjs';
import { fromFile, lastUsage } from './opencodesession.mjs';

export { fromFile, lastUsage };

const ID = 'opencode';
const base = hookonly.make(ID);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ the screen

const OPTIONS = ['Allow once', 'Allow always', 'Reject'];
const REPLY = { 'Allow once': 'once', 'Allow always': 'always', Reject: 'reject' };
const strip = (l) => l.replace(/^\s*┃\s?/, '').trim();

export function parseScreen(text) {
  const out = base.parseScreen(text);
  if (text == null) return out;
  const lines = String(text).split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const n = lines.length;
  const lastIdx = (re, from = 0) => { for (let i = n - 1; i >= from; i--) if (re.test(lines[i])) return i; return -1; };
  // A permission prompt, at the bottom in place of the prompt box.
  const opts = lastIdx(/Allow once\s+Allow always\s+Reject/);
  const ask = opts >= 0 ? lastIdx(/△\s*Permission required/) : -1;
  const permOpen = opts >= 0 && ask >= 0 && ask < opts && n - opts <= 4;
  // The prompt box's bottom edge and the footer under it.
  const box = lastIdx(/^\s*╹▀{8,}/);
  const footer = box >= 0 ? lines.slice(box + 1).join(' ') : '';
  const boxLive = box >= 0 && n - box <= 4 && /ctrl\+p|esc interrupt/.test(footer);
  out.claudeLive = permOpen || boxLive;
  if (!out.claudeLive) return out;
  out.working = boxLive && /esc interrupt/.test(footer);
  if (permOpen) {
    const body = lines.slice(ask + 1, opts).map(strip).filter(Boolean);
    const what = body.filter((l) => !l.startsWith('#'));
    const q = `Permission required${what.length ? ': ' + what.join(' ') : ''}`;
    out.dialog = {
      question: q.length > 300 ? q.slice(0, 297) + '...' : q,
      options: OPTIONS.map((label, i) => ({ n: i + 1, label, selected: false })),
      lines: [strip(lines[ask]), ...body, OPTIONS.join('   ')],
    };
  }
  // What is typed in the box: its rows above the agent and model line.
  if (boxLive && !permOpen) {
    const agent = lastIdx(/^\s*┃\s+\S.*·.*\S/, Math.max(0, box - 12));
    if (agent >= 0 && agent < box) {
      let top = agent - 1;
      while (top >= 0 && /^\s*┃/.test(lines[top]) && agent - top < 12) top--;
      const typed = lines.slice(top + 1, agent).map(strip).filter(Boolean);
      // Its placeholder ("Ask anything...") is not a draft.
      out.draft = typed.length && !/^Ask anything/.test(typed[0]) ? typed.join('\n') : '';
    }
  }
  out.footer = box >= 0 ? lines.slice(box + 1).map((l) => l.trim()).filter(Boolean) : [];
  const m = String(text).match(/opencode (?:-s|--session) (ses_[A-Za-z0-9]{8,64})/g);
  if (m) out.resumeId = m[m.length - 1].split(' ').pop();
  return out;
}

// The pane's title: "OC | <the session's title>".
export function parseTitle(title) {
  const m = /^OC \| (.+)$/.exec(String(title || '').trim());
  return { claude: !!m, busy: false, topic: m ? m[1] : null };
}

// ------------------------------------------------------------ transcripts

export function sessionDir(env = process.env, home = os.homedir()) {
  return path.join(env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, '.local', 'state'), 'ravenry', 'opencode');
}
const SID = /^ses_[A-Za-z0-9]{8,64}$/;

const cache = new Map();
/** The plugin's file of a session, in server/transcript.mjs's shape; null when unreadable. */
export function readTranscript(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.value;
  let value = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    value = fromFile(j);
    value.path = file;
    value.mtimeMs = st.mtimeMs;
  } catch { value = null; }
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, value });
  return value;
}

export function findTranscript(sessionId) {
  if (!SID.test(String(sessionId || ''))) return null;
  const f = path.join(sessionDir(), `${sessionId}.json`);
  return fs.existsSync(f) ? f : null;
}

// Every session of a folder the plugin recorded: { path, sessionId }.
export function transcriptsFor(cwd) {
  if (!cwd) return [];
  const dir = sessionDir();
  let names = [];
  try { names = fs.readdirSync(dir).filter((x) => /^ses_[A-Za-z0-9]+\.json$/.test(x)); } catch { return []; }
  const out = [];
  for (const n of names.slice(-400)) {
    const f = path.join(dir, n);
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j && j.cwd && path.resolve(j.cwd) === path.resolve(cwd)) out.push({ path: f, sessionId: n.slice(0, -5) });
    } catch { /* half written */ }
  }
  return out;
}

export function firstPrompt(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).firstPrompt || null; } catch { return null; }
}

// ------------------------------------------------------------ installed

// Is OpenCode on this Mac? MC_OPENCODE=0|1 decides in tests, and a test
// that does not say counts it as not installed, so an OpenCode on the
// test's Mac never changes what another test sees.
export function installed(settings, env = process.env) {
  if (env.MC_OPENCODE === '0') return false;
  if (env.MC_OPENCODE === '1') return true;
  if (env.TEST_RAVENRY === '1' || env.MC_TEST === '1') return false;
  return !!findBin(ID, env);
}

// ------------------------------------------------------------ permissions

// The board's answers for the plugin, by session: a wait the plugin has
// open (PermissionWait, decided here), or an answer given while none was
// open, kept a short while for the next one.
const waits = new Map(); // session id -> { resolve, timer }
const given = new Map(); // session id -> { reply, at }
const KEEP_MS = 20000;
const WAIT_MS = 22000;

/** The hub's answer to a waiting plugin: { stdout } or null. Not an OpenCode wait: undefined. */
export function decide(rep) {
  if (!rep || rep.assistant !== ID || rep.event !== 'PermissionWait' || !rep.data) return undefined;
  const sid = rep.data.session_id;
  if (!SID.test(String(sid || ''))) return null;
  const g = given.get(sid);
  given.delete(sid);
  if (g && Date.now() - g.at < KEEP_MS) return Promise.resolve({ stdout: `${g.reply}\n` });
  const old = waits.get(sid);
  if (old) { clearTimeout(old.timer); old.resolve(null); }
  return new Promise((resolve) => {
    const w = { resolve, timer: setTimeout(() => { if (waits.get(sid) === w) waits.delete(sid); resolve(null); }, WAIT_MS) };
    waits.set(sid, w);
  });
}

/** Gives the plugin the board's answer: true when a wait took it at once. */
export function answer(sessionId, reply) {
  const w = waits.get(sessionId);
  if (w) {
    waits.delete(sessionId);
    clearTimeout(w.timer);
    w.resolve({ stdout: `${reply}\n` });
    return true;
  }
  given.set(sessionId, { reply, at: Date.now() });
  return false;
}

/** Whether the plugin waits on the board for this session now. */
export const waiting = (sessionId) => waits.has(sessionId);

// The board's choice on a permission prompt: its option's answer goes to
// the plugin, which replies through OpenCode's API; then the prompt must
// leave the screen. { ok, sent, keys, after } or { ok: false, status, error, keys }.
export async function chooseOption({ read, want, sessionId, where = 'the pane', afterMs = 8000, pollMs = 150, parse = parseScreen }) {
  const keys = [];
  const t0text = await read();
  if (t0text == null) return { ok: false, status: 502, error: 'Could not read the tab, so nothing was answered.', keys };
  const s0 = parse(t0text);
  if (!s0.claudeLive || !s0.dialog) return { ok: false, status: 409, error: 'No choice is open on screen any more.', keys };
  const opt = s0.dialog.options.find((o) => o.n === Number(want));
  if (!opt) return { ok: false, status: 409, error: 'That option is no longer on screen.', keys };
  if (!SID.test(String(sessionId || ''))) return { ok: false, status: 409, error: `The board does not know this OpenCode session yet, so nothing was answered. Answer it in ${where}.`, keys };
  answer(sessionId, REPLY[opt.label]);
  const t0 = Date.now();
  do {
    await sleep(pollMs);
    const t = await read();
    if (t == null) continue;
    const s = parse(t);
    if (!s.dialog) { given.delete(sessionId); return { ok: true, sent: opt.label, keys, after: 'closed' }; }
    if (s.dialog.question !== s0.dialog.question) { given.delete(sessionId); return { ok: true, sent: opt.label, keys, after: 'next' }; }
  } while (Date.now() - t0 < afterMs);
  given.delete(sessionId);
  return { ok: false, status: 502, error: `OpenCode did not take the answer: is Ravenry's plugin set up for it (Settings, Hooks)? Answer it in ${where}.`, keys };
}

// ------------------------------------------------------------ its models

let models = { at: 0, list: [], running: false, key: '' };
const MODEL_LINE = /^[A-Za-z0-9][\w.-]*\/[\w.:/@+-]+$/;

/** Parses `opencode models`: provider/model ids, one per line. */
export const parseModels = (text) => String(text || '').split('\n').map((l) => l.trim()).filter((l) => MODEL_LINE.test(l) && l.length <= 120);

/** The models `opencode models` listed last (read again in the background every 10 minutes). */
export function modelList(env = process.env) {
  const bin = env.MC_OPENCODE_BIN || findBin(ID, env);
  if (!bin || !installed({}, env)) return [];
  const key = bin;
  if (!models.running && (models.key !== key || Date.now() - models.at > 10 * 60000)) {
    models.running = true;
    execFile(bin, ['models'], { env, timeout: 60000, maxBuffer: 4 << 20 }, (err, stdout) => {
      const list = parseModels(stdout);
      // A run that failed or listed nothing (OpenCode busy installing its
      // plugins' packages on a first start) is tried again in 10 s.
      if (err || !list.length) models = { at: Date.now() - 10 * 60000 + 10000, list: models.list, running: false, key };
      else models = { at: Date.now(), list, running: false, key };
    });
  }
  return models.list;
}
export const modelsReady = () => models.list.length > 0;

// ------------------------------------------------------------ the adapter

export const adapter = {
  ...base,
  parseScreen,
  parseTitle,
  judgedScreen: (x) => ({ ...parseScreen(x ? x.text : null), suggestion: null, prompt: { kind: 'empty', sure: true, by: 'screen' } }),
  findTranscript: (sessionId) => findTranscript(sessionId),
  transcriptsFor,
  readTranscript,
  firstPrompt,
  installed,
  chooseOption,
  decide,
};
