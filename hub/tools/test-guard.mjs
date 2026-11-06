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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
