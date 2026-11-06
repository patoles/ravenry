#!/usr/bin/env node
// Stands in for `osascript -e 'POSIX path of (choose folder)'` in tests
// (MC_CHOOSE_FOLDER_COMMAND). What it does is read from the file named by
// STUB_CHOOSE_FILE, so one test board can try every answer:
//   "cancel"         exits 1 the way osascript does when the dialog is cancelled
//   "sleep <ms>"     waits that long, then follows the next line
//   anything else    printed as the chosen folder, with osascript's trailing slash
import fs from 'node:fs';

const lines = fs.readFileSync(process.env.STUB_CHOOSE_FILE, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
let i = 0;
const next = () => {
  const l = lines[i++] || 'cancel';
  // Exit only once the write has gone out.
  if (l === 'cancel') { process.stderr.write('execution error: User canceled. (-128)\n', () => process.exit(1)); return; }
  const m = l.match(/^sleep (\d+)$/);
  if (m) { setTimeout(next, Number(m[1])); return; }
  process.stdout.write(l.replace(/\/?$/, '/') + '\n', () => process.exit(0));
};
next();
