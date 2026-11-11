#!/usr/bin/env node
// A brief's Plan task ticked or unticked from an app (server/brief.mjs
// tickTask, POST /api/brief/tick): found by its objective and its words,
// never guessed (none or two alike: nothing written), never a plan's step,
// its line's other words and line ending kept. Pure function; no hub.
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import { tickTask, parseBrief } from '../server/brief.mjs';

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

const MD = `# Boat

## Plan
- [x] Print the tower
- [>] Fit the lamp
- [?] Pick the beam colour (you)

### Rig the sail
- [ ] Tag the mast
- [ ] Tag the mast
- [ ] Sew the hem

### Find why the hull leaks
Runs on its own. Started: 2026-11-04 09:00.
- [ ] Do: Float the hull

## Notes
- [ ] Fit the lamp
`;
const line = (md, re) => md.split('\n').find((l) => re.test(l));
const state = (md, obj, text) => parseBrief(md).plan.find((o) => o.title === obj).tasks.find((t) => t.text === text).state;

let r = tickTask(MD, '', 'Fit the lamp', true);
check('a task under way is ticked done', r && line(r, /Fit the lamp/) === '- [x] Fit the lamp' && state(r, 'Plan', 'Fit the lamp') === 'done');
check('the Notes box with the same words is left as it was', r && r.split('\n').filter((l) => l === '- [ ] Fit the lamp').length === 1);
r = tickTask(MD, 'Plan', 'Pick the beam colour', true);
check('a task with a state tag is found by its words, the tag kept', r && line(r, /beam colour/) === '- [x] Pick the beam colour (you)' && state(r, 'Plan', 'Pick the beam colour') === 'done');
r = tickTask(MD, 'Plan', 'Print the tower', false);
check('a done task is unticked', r && line(r, /Print the tower/) === '- [ ] Print the tower');
r = tickTask(MD, 'Rig the sail', 'Sew the hem', true);
check('a task under its objective is ticked', r && line(r, /Sew the hem/) === '- [x] Sew the hem');
check('two tasks with the same words: nothing is written', tickTask(MD, 'Rig the sail', 'Tag the mast', true) === null);
check('a task under another objective is not found', tickTask(MD, 'Rig the sail', 'Print the tower', true) === null);
check('a plan\'s step is never ticked by hand', tickTask(MD, 'Find why the hull leaks', 'Do: Float the hull', true) === null);
check('a task that is gone: nothing is written', tickTask(MD, '', 'Paint the hull', true) === null);
r = tickTask(MD.replace(/\n/g, '\r\n'), '', 'Fit the lamp', true);
check('Windows line endings are kept', r && r.includes('- [x] Fit the lamp\r\n') && !r.includes('\r\r'));

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
