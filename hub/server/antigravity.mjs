// Antigravity CLI's adapter (docs/ASSISTANTS.md, "Antigravity CLI"),
// measured on agy 1.5.14. Its state comes from Ravenry's group in
// ~/.gemini/config/hooks.json (`ravenryd hook --state` on SessionStart,
// PreInvocation and Stop, server/hookinstall.mjs); this adapter adds what
// the board reads of its screen and its transcript:
//
//   the screen      its full-screen interface: the prompt between two rules,
//                   and under them a footer whose right end is the model and
//                   its effort ("Gemini 3.8 Flash · high", after "auto · "
//                   in Auto mode); "esc to cancel" at its left while a turn
//                   runs, "? for shortcuts" at rest
//   a permission    it has no hook for one, so it is read here: "Requesting
//                   permission for:", what, "Run this command?", then the
//                   numbered answers with ">" at the selected one and
//                   "↑/↓ Navigate" under them. The board picks one with the
//                   arrows and Enter (server/choose.mjs), as for Claude Code
//   the transcript  brain/<id>/.system_generated/logs/transcript_full.jsonl
//                   (server/antigravitysession.mjs): model, tokens in use,
//                   last message, prompts; no context window
//   its models      `agy models`: an id and its label a line ("gemini-3.8-
//                   flash-high", "Gemini 3.8 Flash (High)"), read only when
//                   the person needs them (server/modellists.mjs)

import fs from 'node:fs';
import path from 'node:path';
import * as hookonly from './hookonly.mjs';
import { findBin, homeDir } from './assistantfind.mjs';
import { readFile, lastUsage, fromText } from './antigravitysession.mjs';
import * as lists from './modellists.mjs';

export { readFile, lastUsage, fromText };

const ID = 'antigravity';
const base = hookonly.make(ID);

// ------------------------------------------------------------ the screen

const RULE = /^\s*─{20,}\s*$/;
// The footer's right end: [mode · ]<model> · <effort>.
const FOOTER = /(?:^|\s{2,})((?:(?:auto|plan|accept-edits) · )?[A-Za-z][\w .()+-]*? · (?:low|medium|high|xhigh|max|minimal|default))\s*$/;
const OPTION = /^\s*(>\s+)?(\d{1,2})\.\s+(\S.*?)\s*$/;
const PLACEHOLDER = /^[A-Za-z-]+ mode: /;

/** The model label and effort the footer shows: { mode, model, effort } or null. */
export function footerModel(line) {
  const m = FOOTER.exec(String(line || ''));
  if (!m) return null;
  const parts = m[1].split(' · ');
  const effort = parts.pop();
  const model = parts.pop();
  return { mode: parts.pop() || null, model, effort };
}

/** Is this Antigravity CLI's screen? Its footer, under a rule, at the bottom. */
export function claims(text) {
  if (text == null) return false;
  const lines = String(text).split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const n = lines.length;
  if (!n || !footerModel(lines[n - 1])) return false;
  for (let i = n - 2; i >= Math.max(0, n - 40); i--) if (RULE.test(lines[i])) return true;
  return false;
}

export function parseScreen(text) {
  const out = base.parseScreen(text);
  if (text == null) return out;
  const lines = String(text).split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const n = lines.length;
  const m = String(text).match(/agy --conversation[= ]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g);
  if (m) out.resumeId = m[m.length - 1].slice(-36);
  if (!claims(text)) {
    // Its exit: "Resume with -c (or command below):" and the command.
    if (m && n && /agy --conversation/.test(lines[n - 1])) out.exited = true;
    return out;
  }
  out.claudeLive = true;
  const foot = lines[n - 1];
  out.footer = [foot.trim()];
  // A menu: numbered answers with "↑/↓ Navigate" under them.
  let hint = -1;
  for (let i = n - 1; i >= Math.max(0, n - 5); i--) if (/↑\/↓ Navigate/.test(lines[i])) { hint = i; break; }
  if (hint > 0) {
    let i = hint - 1;
    while (i >= 0 && !lines[i].trim()) i--;
    const opts = [];
    while (i >= 0 && OPTION.test(lines[i]) && opts.length < 12) { opts.unshift(lines[i]); i--; }
    if (opts.length >= 2) {
      const options = opts.map((l) => { const o = OPTION.exec(l); return { n: Number(o[2]), label: o[3], selected: !!o[1] }; });
      // What it asks: the lines above, up to the rule over the menu.
      const ask = [];
      for (let k = i; k >= 0 && ask.length < 8 && !RULE.test(lines[k]); k--) if (lines[k].trim()) ask.unshift(lines[k].trim());
      // "Requesting permission for:", what, "Run this command?" reads as
      // "Run this command? <what>".
      const said = /^Requesting permission for:?$/.test(ask[0] || '') && ask.length >= 3 ? [ask[ask.length - 1], ...ask.slice(1, -1)] : ask;
      const q = said.join(' ').replace(/\s+/g, ' ').trim() || 'Antigravity CLI asks';
      out.dialog = {
        question: q.length > 300 ? q.slice(0, 297) + '...' : q,
        options,
        lines: [...ask, ...options.map((o) => `${o.n}. ${o.label}`)],
      };
    }
  }
  out.working = !out.dialog && /^\s*esc to cancel\b/.test(foot);
  // What is typed at the prompt: the line after "> " between the last two rules.
  if (!out.dialog) {
    const rules = [];
    for (let i = n - 2; i >= 0 && rules.length < 2; i--) if (RULE.test(lines[i])) rules.push(i);
    if (rules.length === 2 && rules[0] - rules[1] >= 2) {
      const box = lines.slice(rules[1] + 1, rules[0]);
      const first = (box[0] || '').replace(/^\s*>\s?/, '');
      const typed = [first, ...box.slice(1).map((l) => l.replace(/^\s{2}/, ''))].join('\n').trim();
      out.draft = typed && !PLACEHOLDER.test(typed) ? typed : '';
    }
  }
  out.body = lines.filter((l) => l.trim()).slice(-12);
  return out;
}

// ------------------------------------------------------------ transcripts

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const home = (env = process.env) => homeDir(ID, env);
const transcriptOf = (id, env) => path.join(home(env), 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');

export function findTranscript(sessionId) {
  if (!UUID.test(String(sessionId || ''))) return null;
  const f = transcriptOf(sessionId);
  return fs.existsSync(f) ? f : null;
}

// Every conversation of a folder, as { path, sessionId }: Antigravity
// CLI's own list of them (cache/conversation_metadata.json, each with its
// workspace folders).
export function transcriptsFor(cwd) {
  if (!cwd) return [];
  let j = null;
  try { j = JSON.parse(fs.readFileSync(path.join(home(), 'cache', 'conversation_metadata.json'), 'utf8')); } catch { return []; }
  const want = `file://${path.resolve(cwd)}`;
  const out = [];
  for (const [id, c] of Object.entries((j && j.conversations) || {})) {
    const uris = (c && c.summary && c.summary.WorkspaceURIs) || [];
    if (!UUID.test(id) || !uris.some((u) => String(u).replace(/\/$/, '') === want)) continue;
    const f = transcriptOf(id);
    if (fs.existsSync(f)) out.push({ path: f, sessionId: id });
  }
  return out;
}

export function newestTranscriptFor(cwd, exclude = new Set()) {
  let best = null;
  for (const t of transcriptsFor(cwd)) {
    if (exclude.has(t.sessionId) || exclude.has(t.path)) continue;
    let m = 0;
    try { m = fs.statSync(t.path).mtimeMs; } catch { continue; }
    if (!best || m > best.m) best = { ...t, m };
  }
  return best ? best.path : null;
}

export function readTranscript(file) {
  // Its model's label: from what `agy models` listed last, never a run of it.
  const v = readFile(file);
  if (v && v.model) v.modelLabel = labelOf(v.model);
  return v;
}

export function firstPrompt(file) {
  const v = readFile(file);
  return v ? v.firstPrompt : null;
}

// ------------------------------------------------------------ installed

// Is Antigravity CLI on this Mac? MC_ANTIGRAVITY=0|1 decides in tests, and
// a test that does not say counts it as not installed, so an agy on the
// test's Mac never changes what another test sees.
export function installed(settings, env = process.env) {
  if (env.MC_ANTIGRAVITY === '0') return false;
  if (env.MC_ANTIGRAVITY === '1') return true;
  if (env.TEST_RAVENRY === '1' || env.MC_TEST === '1') return false;
  return !!findBin(ID, env);
}

// ------------------------------------------------------------ its models

/** Parses `agy models`: [{ id, label }], one a line ("id<TAB>label"). */
export function parseModels(text) {
  const out = [];
  for (const l of String(text || '').split('\n')) {
    const m = /^([a-z0-9][\w.-]{1,79})\t+(\S.{0,99}?)\s*$/.exec(l);
    if (m) out.push({ id: m[1], label: m[2] });
  }
  return out;
}

/** The label `agy models` gave a model id ("Gemini 3.8 Flash (High)"), else null. */
export function labelOf(id) {
  const m = lists.cached(ID).find((x) => x && x.id === id);
  return m ? m.label : null;
}

const binOf = (env) => { const bin = env.MC_ANTIGRAVITY_BIN || findBin(ID, env); return bin && installed({}, env) ? bin : null; };

/** The models `agy models` listed last ([{ id, label }]); never runs it. */
export const modelList = (env = process.env) => (binOf(env) ? lists.cached(ID) : []);

/**
 * The person needs the list (New session, the Model menu, a session of it
 * starting): `agy models` runs when the last list is older than
 * modellists.MAX_AGE, or a minute after a run that listed nothing (signed
 * out, offline). A promise of the list.
 */
export function askModels(env = process.env) {
  const bin = binOf(env);
  return bin ? lists.ask(ID, { bin, args: ['models'], env, parse: parseModels, retryMs: 60000 }) : Promise.resolve([]);
}

// ------------------------------------------------------------ the adapter

export const adapter = {
  ...base,
  parseScreen,
  claims,
  judgedScreen: (x) => ({ ...parseScreen(x ? x.text : null), suggestion: null, prompt: { kind: 'empty', sure: true, by: 'screen' } }),
  findTranscript: (sessionId) => findTranscript(sessionId),
  newestTranscriptFor,
  transcriptsFor,
  readTranscript,
  firstPrompt,
  installed,
};

