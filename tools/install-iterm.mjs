#!/usr/bin/env node
// Sets up what the board's iTerm2 adapter needs to press arrow keys
// (server/iterm.mjs, server/iterm-keys.py): a private Python venv at
// ~/.ravenry/iterm2-py with iTerm2's `iterm2` package. Everything else the
// adapter does goes through AppleScript and needs nothing installed.
// Idempotent: a venv that already imports iterm2 is left as it is.
// `ravenry setup` does the same in iTerm2 (server/itermhelper.mjs).
//
//   node tools/install-iterm.mjs           make the venv and install iterm2
//   node tools/install-iterm.mjs --check   say whether it is ready, change nothing
//
// iTerm2 itself must have the Python API on (Settings > General > Magic >
// Enable Python API). The first time the board talks to iTerm2, macOS may
// ask once to let it control iTerm2 (Automation).
import { helperState, makeHelper } from '../server/itermhelper.mjs';

const check = process.argv.includes('--check');
const st = helperState();
if (st.ready) {
  console.log(`Ready: ${st.python} imports iterm2.`);
  process.exit(0);
}
if (check) {
  console.log(st.python ? `Not ready: ${st.python} does not import iterm2. Run node tools/install-iterm.mjs.` : 'Not ready: no Python with iterm2. Run node tools/install-iterm.mjs.');
  process.exit(1);
}
const r = makeHelper((s) => console.log(s));
if (!r.ok) { console.error(r.error); process.exit(1); }
console.log(`Ready: ${r.python} imports iterm2.`);
