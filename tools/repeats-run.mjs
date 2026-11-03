// Runs the repeats detector once, outside the board, against RAVENRY_HOME's
// registry settings (so a scratch RAVENRY_HOME points it at temp CLAUDE.md
// copies). Prints the run record. MC_HOME, the pre-rename name, works too.
//
//   RAVENRY_HOME=<dir> node tools/repeats-run.mjs            # seed if needed, then one run (model calls)
//   RAVENRY_HOME=<dir> node tools/repeats-run.mjs --seed     # seed only, no model call
//   RAVENRY_HOME=<dir> node tools/repeats-run.mjs --view     # print what the Suggested tab shows

import * as registry from '../server/registry.mjs';
import { config } from '../server/config.mjs';
import * as repeats from '../server/repeats.mjs';
import { HOME_OVERRIDE } from '../server/home.mjs';

if (!HOME_OVERRIDE) {
  console.error('Set RAVENRY_HOME. This tool writes into <RAVENRY_HOME>/repeats, and the real board owns ~/.ravenry.');
  process.exit(2);
}
const reg = registry.load();
const cfg = config(reg ? reg.settings : {}, reg ? reg.projects : []);
const arg = process.argv[2] || '';

if (arg === '--seed') {
  const t = Date.now();
  await repeats.ensureSeed(cfg);
  console.log(JSON.stringify(repeats.load().state.seeded, null, 1), `\n${Date.now() - t} ms`);
} else if (arg === '--view') {
  const v = repeats.view(cfg);
  for (const r of v.rows) console.log(`${String(r.messages).padStart(3)} ${String(r.sessions).padStart(2)}  ${r.last.padEnd(6)} ${r.button.padEnd(21)} ${r.id}  | ${r.quote ? r.quote.project + ', ' + r.quote.date : 'no quote'}${r.tail ? '  | ' + r.tail : ''}`);
  console.log(`${v.count} rows, ${v.sessions} sessions in the store`);
} else {
  const rec = await repeats.run(cfg, { reason: 'manual' });
  console.log(JSON.stringify(rec, null, 1));
}
