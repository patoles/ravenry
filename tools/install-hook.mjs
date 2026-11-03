#!/usr/bin/env node
// Installs Ravenry's two Claude Code hooks in ~/.claude/settings.json, from
// this checkout (`ravenry setup` does the same for an installed copy):
//   hooks/handoff-stop.mjs  on Stop (the clean hand-off, docs/HANDOFF.md)
//   hooks/events.mjs        on SessionStart, SessionEnd, UserPromptSubmit,
//                           Notification and Stop (board state, docs/STATE-RULES.md)
// Idempotent: a rerun changes nothing, except to point an entry at this
// Node and this checkout when they moved. Backs the file up first. Touches
// only entries that run these two scripts (server/hookinstall.mjs): each is
// rewritten in place, and a second copy of the same script on the same
// event is dropped. Every other hook and every other setting stays as it is.
//
//   node tools/install-hook.mjs                     install or update both
//   node tools/install-hook.mjs --remove            remove both
//   node tools/install-hook.mjs --dry-run           print what would change, write nothing
//   node tools/install-hook.mjs --settings <file>   work on another settings file
// MC_CLAUDE_SETTINGS=<file> does the same as --settings (the tests).
import path from 'node:path';
import * as hk from '../server/hookinstall.mjs';

const flag = process.argv.indexOf('--settings');
if (flag !== -1 && !process.argv[flag + 1]) { console.error('--settings needs a file path.'); process.exit(2); }
const file = flag !== -1 ? path.resolve(process.argv[flag + 1]) : hk.SETTINGS_FILE();
const remove = process.argv.includes('--remove');
const dry = process.argv.includes('--dry-run');

let cur;
try { cur = hk.readSettings(file); } catch (e) { console.error(e.message); process.exit(1); }
const { settings, changes } = hk.plan(cur.json, { remove });
const count = (s) => Object.fromEntries(Object.entries(s.hooks || {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]));
if (!changes.length) {
  console.log(`Nothing to change in ${file}: ${remove ? 'neither hook is installed' : 'both hooks are installed'}.`);
  process.exit(0);
}
console.log(changes.map((c) => '  ' + c).join('\n'));
if (dry) {
  console.log(`Dry run: ${file} not written. Entries per event would be ${JSON.stringify(count(settings))}.`);
  process.exit(0);
}
const backup = hk.writeSettings(file, cur.exists ? cur.raw : '{}', settings);
console.log(`Wrote ${file}. Entries per event: ${JSON.stringify(count(hk.readSettings(file).json))}. Backup: ${backup}`);
console.log(remove ? 'Both Ravenry hooks removed.' : 'Hand-off and events hooks installed. New sessions pick them up; /hooks in a running session shows whether it has.');
