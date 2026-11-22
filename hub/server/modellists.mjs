// The models an assistant's own program lists (`opencode models`, `agy
// models`), for New session's Model menu and the model chip's label
// (docs/ASSISTANTS.md, "Model lists").
//
// The program runs only when the person needs the list: they open New
// session (GET /api/setup/start), the board's Model menu for that assistant
// (POST /api/assistant/models), or a session of that assistant starts
// (index.mjs launchFor). Everything else, the state's tick and a
// transcript's read among them, reads what was listed last and never starts
// the program. A list is asked again only after MAX_AGE (or `retryMs` after
// a run that failed or listed nothing), so nothing runs while nobody looks.
// On 2026-11-22 the state's tick ran `agy models` every 10 minutes all
// night: each run started Antigravity's language server and wrote a log
// file into the person's ~/.gemini.
//
// The last good list of each is kept in <data>/model-lists.json, so a
// restarted board shows the menu and the labels at once.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { RAVENRY_HOME } from './home.mjs';

export const MAX_AGE = 10 * 60000;
const FILE = () => path.join(RAVENRY_HOME, 'model-lists.json');

// name -> { at, list, key, failedAt, running (a promise) }
const lists = new Map();
let saved = null;

function entry(name) {
  if (!saved) { try { saved = JSON.parse(fs.readFileSync(FILE(), 'utf8')) || {}; } catch { saved = {}; } }
  if (!lists.has(name)) {
    const s = saved[name];
    lists.set(name, s && Array.isArray(s.list) ? { at: Number(s.at) || 0, list: s.list, key: s.key || '', failedAt: 0, running: null } : { at: 0, list: [], key: '', failedAt: 0, running: null });
  }
  return lists.get(name);
}

function save(name, e) {
  saved = { ...saved, [name]: { at: e.at, list: e.list, key: e.key } };
  try { fs.mkdirSync(RAVENRY_HOME, { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(saved) + '\n'); } catch { /* kept in memory */ }
}

/** What `name`'s program listed last ([] before it ever did). Never runs it. */
export const cached = (name) => entry(name).list;

/** Whether a list of `name` is being read now. */
export const reading = (name) => !!entry(name).running;

/**
 * The person needs `name`'s list: runs `bin args` unless a run is on its
 * way or the last one is fresh (MAX_AGE after a good one, `retryMs` after
 * one that failed or listed nothing). A promise of the list, which is the
 * last one until the run ends.
 */
export function ask(name, { bin, args, env, parse, retryMs = 60000, timeout = 60000, maxBuffer = 1 << 20 }) {
  const e = entry(name);
  if (e.running) return e.running;
  // Fresh: younger than its age limit (a clock set back makes it old).
  const young = (at, ms) => { const age = Date.now() - at; return at > 0 && age >= 0 && age < ms; };
  const fresh = e.key === bin && (e.failedAt > e.at ? young(e.failedAt, retryMs) : young(e.at, MAX_AGE));
  if (fresh) return Promise.resolve(e.list);
  e.running = new Promise((resolve) => {
    execFile(bin, args, { env, timeout, maxBuffer }, (err, stdout) => {
      const list = err ? [] : parse(stdout);
      // Signed out, offline, or busy setting itself up: the last list stays,
      // and the next ask after retryMs tries again.
      if (!list.length) Object.assign(e, { failedAt: Date.now(), key: bin, running: null });
      else { Object.assign(e, { at: Date.now(), failedAt: 0, list, key: bin, running: null }); save(name, e); }
      resolve(e.list);
    });
  });
  return e.running;
}

/** A promise of the list, waiting at most `ms` for a run on its way. */
export function within(promise, ms, fallback) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(fallback), ms).unref())]);
}
