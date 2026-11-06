// Where Ravenry keeps its data: RAVENRY_HOME, else MC_HOME (the override's
// name from when the board was called Mission Control), else ~/.ravenry.
// A Mac that has only the pre-rename ~/.mission-control and no ~/.ravenry
// keeps using it, so the hooks fired by live sessions while the folder is
// being moved never split the data across two folders.
// Node built-ins only, and cheap: hooks/events.mjs imports it on every event.
//
// The guards (2026-11-03): tools/iterm-mode-test.mjs imported a server module
// before it set RAVENRY_HOME, so this file had already settled on the real
// ~/.ravenry; the test then wrote its scratch registry into the user's real
// projects.json, and their board loaded it at its next start. So:
//   - A test process (TEST_RAVENRY=1 or MC_TEST=1, set by tools/test-guard.mjs
//     before anything else loads) whose data folder is not inside this
//     repo's .tmp refuses to load at all: it never falls back to ~/.ravenry.
//   - assertDataWrite() refuses a write into the real data folder from a
//     test, or from a process whose RAVENRY_HOME changed after this file
//     settled (the exact way the test reached the real file).
//   - SCRATCH_DATA says the data folder is a test's; a real board never
//     adopts a path inside the repo's .tmp (inRepoTmp) as its own.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This repo's scratch folder: every test keeps its data here.
export const REPO_TMP = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '.tmp');

const realOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const inside = (p, dir) => { const r = path.relative(dir, p); return r === '' || (!!r && !r.startsWith('..') && !path.isAbsolute(r)); };

// True for a path inside the repo's .tmp (symlinks resolved where they exist).
export function inRepoTmp(p) {
  if (typeof p !== 'string' || !p.trim() || !path.isAbsolute(p)) return false;
  return inside(path.resolve(p), REPO_TMP) || inside(realOr(p), realOr(REPO_TMP));
}

// Every string anywhere in `value` that names a path inside the repo's .tmp.
export function repoTmpPaths(value, out = []) {
  if (typeof value === 'string') { if (value.includes('.tmp') && inRepoTmp(value)) out.push(value); }
  else if (Array.isArray(value)) for (const v of value) repoTmpPaths(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) repoTmpPaths(v, out);
  return out;
}

const overrideOf = (env) => env.RAVENRY_HOME || env.MC_HOME || '';
export const isTestEnv = (env = process.env) => env.TEST_RAVENRY === '1' || env.MC_TEST === '1';

// Set when a test or a scratch board points the data somewhere else.
export const HOME_OVERRIDE = overrideOf(process.env);

// The user's own data folders, from the account as well as HOME (a test may
// point HOME at a scratch folder).
function realHomes() {
  const hs = new Set([os.homedir()]);
  try { if (os.userInfo().homedir) hs.add(os.userInfo().homedir); } catch { /* HOME only */ }
  return [...hs].flatMap((h) => [path.join(h, '.ravenry'), path.join(h, '.mission-control')]).filter((d) => !inRepoTmp(d));
}
export function inRealData(p) {
  const abs = path.resolve(p);
  return realHomes().some((d) => inside(abs, d) || inside(realOr(abs), realOr(d)));
}

function pick() {
  if (HOME_OVERRIDE) return HOME_OVERRIDE;
  const now = path.join(os.homedir(), '.ravenry');
  const old = path.join(os.homedir(), '.mission-control');
  if (!fs.existsSync(now) && fs.existsSync(old)) return old;
  return now;
}

export const RAVENRY_HOME = pick();
// The data folder is a test's (inside the repo's .tmp).
export const SCRATCH_DATA = inRepoTmp(RAVENRY_HOME);

if (isTestEnv() && !SCRATCH_DATA) {
  throw new Error(`Ravenry: a test process must keep its data inside ${REPO_TMP}, not ${RAVENRY_HOME}. Set RAVENRY_HOME to a folder there before anything imports server/home.mjs (tools/test-guard.mjs does).`);
}

// Throws unless `file` may be written by this process. Every write into the
// data folder that could lose the user's state goes through it.
export function assertDataWrite(file, env = process.env) {
  if (!inRealData(file)) return;
  const live = overrideOf(env);
  if (isTestEnv(env)) throw new Error(`Ravenry: refused to write ${file}: a test never writes the real data folder.`);
  if (live !== HOME_OVERRIDE) throw new Error(`Ravenry: refused to write ${file}: RAVENRY_HOME is now ${JSON.stringify(live)} but this process settled on ${RAVENRY_HOME} before it was set.`);
  if (inRepoTmp(live)) throw new Error(`Ravenry: refused to write ${file}: RAVENRY_HOME points into ${REPO_TMP}.`);
}
