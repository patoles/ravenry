// macOS's privacy prompt, before the board reads a protected folder.
//
// macOS asks the person before an app reads ~/Documents, ~/Desktop,
// ~/Downloads, iCloud Drive or another volume, and a read made before they
// answer does not fail: it waits until they do. On 2026-11-07 the app's
// 0.1.2 hub sat in a synchronous read of a brief in ~/Documents: it was
// listening, its main thread was stuck, and it answered nothing, while
// macOS's dialog waited on the screen. (An app signed ad hoc is a new app
// to macOS at every build, so every build asks again.)
//
// The board reads its projects' folders synchronously (briefs, pages, rule
// files), so before it reads any it asks for each protected folder its
// projects live in with one read off the main thread (libuv's pool), and
// until that read returns the hub answers every request with 503 and says
// which folder (server/index.mjs): the window then says "macOS is asking
// whether Ravenry may read ~/Documents". Refused, the board goes on and
// those reads fail at once; the state says so.
//
// MC_ACCESS_PROBE (tests): a JSON object { "<root>": "<file to open>" }
// whose roots count as protected on any system and are asked by opening
// that file (a FIFO stands for a read that does not return yet).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROBES = (() => { try { return process.env.MC_ACCESS_PROBE ? JSON.parse(process.env.MC_ACCESS_PROBE) : {}; } catch { return {}; } })();
const state = new Map(); // root -> { state: 'waiting' | 'ok' | 'denied', since, error }
let changed = () => {};

/** Called when a folder's answer comes (the board ticks again). */
export function onChange(fn) { changed = typeof fn === 'function' ? fn : () => {}; }

/** What macOS calls the folder in its prompt and in Settings. */
export function label(root, home = os.homedir()) {
  const rel = path.relative(home, root);
  if (rel === 'Documents' || rel === 'Desktop' || rel === 'Downloads') return rel;
  if (rel === path.join('Library', 'Mobile Documents')) return 'iCloud Drive';
  if (root.startsWith('/Volumes/')) return 'Removable Volumes';
  return path.basename(root);
}

/** The protected folders these folders are in (macOS; and the test roots). */
export function protectedRoots(folders, { home = os.homedir(), platform = process.platform } = {}) {
  const roots = Object.keys(PROBES).map((r) => path.resolve(r));
  if (platform === 'darwin') roots.push(...['Documents', 'Desktop', 'Downloads', path.join('Library', 'Mobile Documents')].map((r) => path.join(home, r)));
  const out = new Set();
  for (const f of folders) {
    if (!f || typeof f !== 'string' || !path.isAbsolute(f)) continue;
    const abs = path.resolve(f);
    for (const r of roots) if (abs === r || abs.startsWith(r + path.sep)) out.add(r);
    if (platform === 'darwin' && abs.startsWith('/Volumes/') && abs.split('/')[2]) out.add(`/Volumes/${abs.split('/')[2]}`);
  }
  return [...out];
}

// A refused folder is asked again each minute: the person may turn it on
// in System Settings meanwhile.
function probe(root) {
  const was = state.get(root);
  if (was && !(was.state === 'denied' && Date.now() - was.since > 60000)) return;
  // Asked again after a refusal, it stays refused until the answer comes.
  state.set(root, was ? { ...was, since: Date.now() } : { state: 'waiting', since: Date.now(), error: null });
  const target = PROBES[root] || null;
  const read = target ? fs.promises.open(target, 'r').then((h) => h.close()) : fs.promises.readdir(root);
  read.then(
    () => { state.set(root, { state: 'ok', since: Date.now(), error: null }); changed(root); },
    (e) => {
      const refused = e && (e.code === 'EPERM' || e.code === 'EACCES');
      state.set(root, { state: refused ? 'denied' : 'ok', since: Date.now(), error: refused ? e.code : null });
      if (refused) console.error(`access: macOS did not let the board read ${root} (${e.code})`);
      changed(root);
    },
  );
}

/**
 * Asks for each protected folder of these folders not asked yet, and
 * returns the first one whose answer has not come, or null when the board
 * may read them all (or was refused: those reads fail at once).
 */
export function waitFor(folders) {
  const roots = protectedRoots(folders);
  for (const r of roots) probe(r);
  return roots.find((r) => state.get(r).state === 'waiting') || null;
}

/** A folder whose answer has not come, of those asked so far, or null. */
export function pending() {
  for (const [r, s] of state) if (s.state === 'waiting') return r;
  return null;
}

/** For the state: { waiting, denied } with each folder said as ~/... and named. */
export function view(say = (p) => p) {
  const w = pending();
  const denied = [...state].filter(([, s]) => s.state === 'denied').map(([r]) => ({ folder: say(r), name: label(r) }));
  return { waiting: w ? { folder: say(w), name: label(w), since: new Date(state.get(w).since).toISOString() } : null, denied };
}

/** The words for a folder whose answer has not come. */
export function waitingWords(root, say = (p) => p) {
  return `macOS is asking whether Ravenry may read ${say(root)}. Click Allow in the dialog. If the dialog is gone: System Settings > Privacy & Security > Files & Folders > Ravenry, turn on ${label(root)}.`;
}
