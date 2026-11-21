// The first import of every test (tools/*-test.mjs, tools/*-e2e.mjs), before
// anything that loads server/home.mjs. It keeps a test off the user's real data:
//
// - TEST_RAVENRY=1 (and MC_TEST=1) mark the process as a test. home.mjs then
//   refuses to load unless the data folder is inside this repo's .tmp, and
//   refuses any write into the real ~/.ravenry. TEST_RAVENRY is the marker
//   that reaches children: the tests strip RAVENRY_* and MC_* from the env
//   they hand their boards and hooks, so a marker in those names would be
//   gone in exactly the child that lost its RAVENRY_HOME.
// - RAVENRY_HOME (or MC_HOME) set to a folder outside .tmp: the test refuses
//   to start.
// - Not set: it becomes .tmp/<test>/guard-home, so a server module the test
//   imports before it sets its own RAVENRY_HOME lands there, never in
//   ~/.ravenry. On 2026-11-03 tools/iterm-mode-test.mjs imported
//   server/terminal.mjs (which loads home.mjs) before it set RAVENRY_HOME,
//   then saved its scratch registry through server/registry.mjs into the
//   real ~/.ravenry/projects.json.
// - Every ravenryd, hub and app the test starts is checked first
//   (../../tools/test-env.mjs, guardSpawns): HOME, the hub's data, the
//   daemon's runtime and state folders (and the app's data) must be a
//   test's, or it is refused before it starts. On 2026-11-06 a test run
//   started a daemon with the real HOME, which made the real
//   ~/Library/Application Support/Ravenry. withTestHome(env) gives a
//   board the test's own scratch HOME.
// - Every child, and the test itself, finds a stand-in for each assistant
//   it would find as the person's own (tools/test-env.mjs, the
//   assistants): on 2026-11-21 a test board started the person's OpenCode,
//   which called its model.
// - Nothing of the person's own running daemon or board is reachable
//   (tools/test-env.mjs, the person's own daemon and board): the board's
//   address (RAVENRY_HUB_URL, MC_BOARD_URL) goes from this process's
//   environment with the pane variables below, a child given the person's
//   socket or board is refused, and so is a connection to them. On
//   2026-11-21 a client test run from a Ravenry pane opened a pane in the
//   person's daemon. hub/tools/live-guard-test.mjs checks it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardSpawns, isTestPath, paneVarsIn, requireRealTerminal, useRealAssistant, withStubMachine } from '../../tools/test-env.mjs';

// A test that drives the person's real cmux, iTerm2 or Rex on purpose
// calls this first: it ends the test unless RAVENRY_TEST_REAL_TERMINAL=1.
// Every assistant the test and its children would find (Claude Code,
// Codex, Antigravity CLI, OpenCode) is a stand-in on their PATH; only
// opencode-test and antigravity-test opt in to their own real one, with
// useRealAssistant('opencode' | 'agy') before they look for it.
export { requireRealTerminal, useRealAssistant, withStubMachine };

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = path.join(REPO, '.tmp');
// A fresh clone has no .tmp yet, and tests make their folders inside it.
fs.mkdirSync(TMP, { recursive: true });
const inTmp = (p) => { const r = path.relative(TMP, path.resolve(p)); return !!r && !r.startsWith('..') && !path.isAbsolute(r); };

process.env.TEST_RAVENRY = '1';
process.env.MC_TEST = '1';
for (const k of ['RAVENRY_HOME', 'MC_HOME']) {
  const v = process.env[k];
  if (v && !inTmp(v)) {
    console.error(`Refused: ${k}=${v} is outside ${TMP}; a test keeps all its data there.`);
    process.exit(1);
  }
}
if (!process.env.RAVENRY_HOME && !process.env.MC_HOME) {
  const name = path.basename(process.argv[1] || 'test', '.mjs');
  process.env.RAVENRY_HOME = path.join(TMP, name, 'guard-home');
}

export const GUARD_HOME = process.env.RAVENRY_HOME || process.env.MC_HOME;

// The terminal the test was started from is never the one it tests: a
// server module the test imports reads its terminal from this process's
// environment (server/terminal.mjs takes TERM_PROGRAM=ravenry and
// RAVENRY_PANE for a board in a Ravenry pane). On 2026-11-21, run from a
// Ravenry pane, iterm-test found cmux not drivable in its own process.
// withTestHome already leaves them out of a child's environment; this
// leaves them out of the test's own.
for (const k of paneVarsIn(process.env)) delete process.env[k];

guardSpawns();

// A scratch HOME for what the test starts: .tmp/<test>/home.
export const TEST_HOME = path.join(TMP, path.basename(process.argv[1] || 'test', '.mjs'), 'home');

// `env` with HOME set to the test's scratch home (or `home`, a folder of
// the test that holds its projects, for a board that judges folders by
// whether they are in the home folder), unless it is one already.
// Playwright's browsers stay where they are installed (a cache of programs,
// not Ravenry's data), so a board that renders pictures still finds them.
// The terminal of the shell the test runs in is never the board's: the
// pane variables the test only inherited are left out (a variable the test
// set to a value of its own stays). On 2026-11-09 plan-files-test, run
// from a Ravenry pane, handed its board RAVENRY_PANE and
// TERM_PROGRAM=ravenry, so the board picked the Ravenry terminal
// (server/terminal.mjs boardKind), which a test board may not reach, and
// not the stand-in cmux the test is built on.
export function withTestHome(env = process.env, home = null) {
  env = withoutCallerPane(env);
  if (!home && env.HOME && isTestPath(env.HOME, env)) return withStubMachine(env);
  if (home && !isTestPath(home, env)) throw new Error(`withTestHome: ${home} is not a test's folder`);
  fs.mkdirSync(home || TEST_HOME, { recursive: true });
  const browsers = env.PLAYWRIGHT_BROWSERS_PATH || (env.HOME ? path.join(env.HOME, process.platform === 'darwin' ? 'Library/Caches' : '.cache', 'ms-playwright') : null);
  return withStubMachine({ ...env, HOME: home || TEST_HOME, ...(browsers ? { PLAYWRIGHT_BROWSERS_PATH: browsers } : {}) });
}

function withoutCallerPane(env) {
  const out = { ...env };
  for (const k of paneVarsIn(env)) if (out[k] === process.env[k]) delete out[k];
  return out;
}
