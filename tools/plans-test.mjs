#!/usr/bin/env node
// Plans (docs/design/Plans.dc.html; server/planfmt.mjs, planner.mjs,
// planrun.mjs; public/plan-view.js), on crafted input under .tmp/:
// - the plan format: parse, write and round-trip, and old plans read exactly
//   as the parser before plans read them (every brief in docs/ and, read
//   only, the drafted briefs in ~/.ravenry/briefs);
// - the safe brief write: a backup, and every other line kept;
// - the draft schema check; revision highlighting;
// - gate detection; the alert kind, sent through a local stub webhook;
// - the Objectives row.
// No model call, no cmux, no real brief written.
import './test-guard.mjs'; // first: keeps this test off the real ~/.ravenry
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
fs.mkdirSync(path.join(ROOT, '.tmp'), { recursive: true });
const MC = fs.mkdtempSync(path.join(ROOT, '.tmp', 'plans-test-'));
process.env.RAVENRY_HOME = MC;
process.env.MC_ALERT_PRIME_MS = '0';
process.env.MC_ALERT_COOLDOWN_MS = '0';

const fmt = await import('../server/planfmt.mjs');
const brief = await import('../server/brief.mjs');
const planner = await import('../server/planner.mjs');
const planrun = await import('../server/planrun.mjs');
const alerts = await import('../server/alerts.mjs');
const view = await import('../public/plan-view.js');

let failed = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };

const FIX = path.join(ROOT, 'tools', 'fixtures', 'plans', 'brief-plan.md');
const md = fs.readFileSync(FIX, 'utf8');

// ---------------------------------------------------------------- the format
const b = brief.parseBrief(md);
const p = b.plan[0];
check('a ### objective with "Runs on its own" and tagged steps is read as a plan', p.plan === true && p.steps.length === 6);
check('the plan header: started, goal, rules', p.started === '2026-11-03 14:02' && p.goal === 'Make long notes on the paths feel good' && /work the steps/.test(p.rules));
check('kinds and marks', p.steps.map((s) => s.kind + s.mark).join() === 'dox,branchx,dox,donex,gate?,do ');
check('sub-bullets: proof, arm (taken, with its note and time), choices, question, hand-off', (() => {
  const s2 = p.steps[1].subs;
  return p.steps[0].subs[0].k === 'proof' && p.steps[0].subs[0].at === '14:40' && s2[0].k === 'arm' && s2[0].mark === 'x' && s2[0].note === '6 of 9' && s2[0].at === '14:41' && s2[1].mark === '-'
    && p.steps[4].subs[0].k === 'choices' && p.steps[4].subs[0].list.length === 2 && p.steps[4].subs[1].k === 'question' && p.steps[2].subs[1].k === 'handoff';
})());
check('the log', p.log.length === 3 && p.log[1].text === 'Picked up after a hand-off at step 4');
check('steps are also tasks, so every checklist still shows a plan', p.tasks.length === 6 && p.tasks[0].state === 'done' && p.tasks[4].state === 'you' && p.tasks[0].text.startsWith('Do: '));
const blk = fmt.findPlanBlock(md, p.title);
const text = blk.lines.slice(blk.start, blk.end).join('\n');
check('round trip: the plan written back is the same text', fmt.planMarkdown(p) === text);
check('round trip: an edit that changes nothing leaves the whole brief byte for byte', fmt.editPlan(md, p.title, () => {}) === md);
const again = fmt.parsePlanBlock(p.title, fmt.planMarkdown(p).split('\n').slice(1));
check('round trip: parse(write(plan)) is the same plan', JSON.stringify({ ...again }) === JSON.stringify(fmt.parsePlanBlock(p.title, text.split('\n').slice(1))));
check('an objective without plan lines stays a checklist (indented tasks too, as before)', b.plan[1].plan === undefined && b.plan[1].tasks.length === 4 && b.plan[1].tasks[3].text === 'an old-style indented task');

// The parser before plans (brief.mjs at commit 6c22d15, before the planfmt
// import) reads every brief without a plan the same as the parser now. A
// clone without that history (the public repo) skips this.
const oldSrc = (() => {
  try {
    const head = execFileSync('git', ['-C', ROOT, 'show', '6c22d15:server/brief.mjs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return head;
  } catch { return null; }
})();
if (oldSrc) {
  const oldFile = path.join(MC, 'brief-old.mjs');
  fs.writeFileSync(oldFile, oldSrc);
  const old = await import(pathToFileURL(oldFile).href);
  const files = [path.join(ROOT, 'docs', 'BRIEF.example.md'), FIX];
  const drafts = path.join(os.homedir(), '.ravenry', 'briefs');
  try { for (const f of fs.readdirSync(drafts)) if (f.endsWith('.md')) files.push(path.join(drafts, f)); } catch { /* none */ }
  let same = 0;
  let diff = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const a = old.parseBrief(src);
    const n = brief.parseBrief(src);
    // The plan objectives themselves are read anew; everything else must match.
    n.plan = n.plan.map((o) => (o.plan ? a.plan.find((x) => x.title === o.title) : o));
    if (JSON.stringify(a) === JSON.stringify(n)) same++; else diff.push(path.basename(f));
  }
  check(`old plans read exactly as before plans (${same} of ${files.length} briefs)`, !diff.length, diff.join(', '));
} else console.log('SKIP  old plans read as before plans (commit 6c22d15 is not in this history)');

// ---------------------------------------------------------------- writing
const dir = path.join(MC, 'proj');
fs.mkdirSync(dir, { recursive: true });
const bf = path.join(dir, 'BRIEF.md');
fs.writeFileSync(bf, '# Scratch\n\nGoal: Test plans.\n\n## Rules\n- Keep it small.\n\n## Next step\nWrite a plan.\n\n## Hand-off\n- 2026-11-03 10:00 First.\n\n## Notes\n- [ ] "a note"\n');
const before = fs.readFileSync(bf, 'utf8');
const draft = { mode: 'new', title: 'Hello file', goal: 'Make hello.txt say hi', steps: [
  { id: 's1', kind: 'do', text: 'Create hello.txt containing hi', detail: '', arms: [], choices: [] },
  { id: 's2', kind: 'done', text: '`cat hello.txt` prints hi', detail: '', arms: [], choices: [] },
  { id: 's3', kind: 'gate', text: 'Ask me before adding a second line', detail: '', arms: [], choices: ['Add it', 'Leave it'], rule: 'Ask before changing anything else' },
  { id: 's4', kind: 'do', text: 'Add a second line', detail: '', arms: [], choices: [] },
] };
const w = planrun.writeStart(bf, draft);
const after = fs.readFileSync(bf, 'utf8');
check('start writes the plan under a new ## Plan, before Next step', /## Rules\n- Keep it small\.\n\n## Plan\n### Hello file\nRuns on its own\. Started: \d{4}-\d\d-\d\d \d\d:\d\d\. Not in the plan: stop and ask\.\nGoal: "Make hello\.txt say hi"/.test(after) && after.indexOf('## Plan') < after.indexOf('## Next step'));
check('a backup of the brief before the write', w.backup && fs.readFileSync(w.backup, 'utf8') === before);
const block = fmt.planMarkdown(brief.parseBrief(after).plan[0]);
check('every other line of the brief is kept: the brief is the old one with the plan put in', after === before.replace('## Next step', '## Plan\n' + block + '\n\n## Next step'));
check('a second plan while one runs is refused', (() => { try { planrun.writeStart(bf, draft); return false; } catch (e) { return e.status === 409; } })());
const b2 = brief.parseBrief(after).plan[0];
check('the written gate keeps its choices and its rule', b2.steps[2].subs.some((x) => x.k === 'choices' && x.list.join('|') === 'Add it|Leave it') && b2.steps[2].subs.some((x) => x.k === 'rule'));
// The session ticks step 1 and 2, stops at the gate.
let cur = fs.readFileSync(bf, 'utf8')
  .replace('- [ ] Do: Create hello.txt containing hi', '- [x] Do: Create hello.txt containing hi\n  - Proof: wrote hello.txt (10:05)')
  .replace('- [ ] Done when: `cat hello.txt` prints hi', '- [x] Done when: `cat hello.txt` prints hi\n  - Proof: `cat hello.txt` printed hi (10:06)')
  .replace('- [ ] Gate: Ask me before adding a second line\n  - Choices: Add it | Leave it', '- [?] Gate: Ask me before adding a second line\n  - Choices: Add it | Leave it\n  - Question: hello.txt says hi. Add a second line?');
fs.writeFileSync(bf, cur);
const gated = fmt.activePlan(brief.parseBrief(cur).plan);
check('gate detection: a [?] Gate step is the plan waiting at a gate', gated.state === 'gate' && gated.gate.n === 3 && gated.gate.question === 'hello.txt says hi. Add a second line?' && gated.gate.choices.join('|') === 'Add it|Leave it' && !gated.gate.unforeseen);
check('the short question for the row and the alert', gated.gate.short === 'add a second line?');
check('the short question keeps a file name whole and trims a long one', fmt.shortQuestion('hello.txt is done. Do you want a second file (for example greeting.md)?') === 'do you want a second file (for example greeting.md)?' && fmt.shortQuestion('Done. Do you want a second file, for example greeting.md with a short paragraph about it?').length <= 60);
const msg = planrun.writeAnswer({ folder: dir, name: 'Scratch' }, bf, 'Hello file', { choice: 'Add it' });
const ans = fmt.activePlan(brief.parseBrief(fs.readFileSync(bf, 'utf8')).plan);
check('an answer passes the gate, is written under it and logged', ans.state === 'running' && ans.steps[2].state === 'done' && ans.steps[2].answer.text === 'Add it' && /you chose "Add it"/.test(ans.log[ans.log.length - 1].text));
check('the answer goes to the session with the rules', /Plan gate at step 3 of "Hello file" answered: "Add it"/.test(msg) && /Never skip a gate/.test(msg) && !msg.includes("'"));
planrun.writeState({ folder: dir }, bf, 'Hello file', 'paused');
check('pause: State: paused, logged', fmt.activePlan(brief.parseBrief(fs.readFileSync(bf, 'utf8')).plan).state === 'paused');
planrun.writeState({ folder: dir }, bf, 'Hello file', 'running');
check('resume: running again', fmt.activePlan(brief.parseBrief(fs.readFileSync(bf, 'utf8')).plan).state === 'running');
const n = planrun.writePickup(bf, 'Hello file');
const ho = fmt.activePlan(brief.parseBrief(fs.readFileSync(bf, 'utf8')).plan);
check('a hand-off pick-up is logged at the step it starts from', n === 4 && ho.handoffs.some((h) => h.step === 4));
planrun.writeState({ folder: dir }, bf, 'Hello file', 'stopped');
check('stop: no active plan, the plan stays in the brief', fmt.activePlan(brief.parseBrief(fs.readFileSync(bf, 'utf8')).plan) === null && brief.parseBrief(fs.readFileSync(bf, 'utf8')).plan[0].plan);
check('the notes and hand-off sections are untouched after all of it', fs.readFileSync(bf, 'utf8').endsWith('## Hand-off\n- 2026-11-03 10:00 First.\n\n## Notes\n- [ ] "a note"\n'));
check('the start prompt states the rules and has no single quote (it may travel as a shell word)', (() => { const t = planrun.startPrompt({ folder: dir }, bf, 'Hello file'); return /Run the plan "Hello file" in BRIEF\.md/.test(t) && /Proof:/.test(t) && /\[\?\]/.test(t) && /Never skip a gate/.test(t) && /hand-off, read the plan first/.test(t) && !t.includes("'"); })());

// An unforeseen outcome on a Do step.
const odd = fmt.parsePlanBlock('Odd', ['Runs on its own. Started: 2026-11-03 09:00. Not in the plan: stop and ask.', '- [x] Do: Count', '  - Proof: 4 and 4 (09:10)', '- [?] Branch: Which wins?', '  - [ ] If trail: build it', '  - [ ] If ribbon: mock both', '  - Question: A tie, 4 and 4. Which way?', '  - Choices: Build the trail | Mock up both', '- [ ] Do: Build']);
const od = fmt.derive(odd);
check('gate detection: [?] on a step that is not a Gate is "not in the plan, stopped to ask"', od.state === 'gate' && od.gate.unforeseen && od.gate.choices.length === 2 && od.gate.n === 2);
const run = fmt.derive(fmt.parsePlanBlock('Run', ['Runs on its own. Started: 2026-11-03 09:00. Not in the plan: stop and ask.', '- [x] Do: A', '  - Proof: ok (09:01)', '- [ ] Done when: B', '- [ ] Gate: C']), { working: true });
check('running: the first step not ticked is being worked when the session works', run.state === 'running' && run.steps[1].state === 'now' && run.current === 2 && !run.gate);
const fin = fmt.derive(fmt.parsePlanBlock('Fin', ['Runs on its own.', '- [x] Do: A', '- [-] Do: B']));
check('done: every step ticked or not taken', fin.state === 'done');
check('proof kinds: a test line, a screenshot, text', fmt.proofKind('14 passed, 0 failed').type === 'test' && fmt.proofKind('shots/trail-held.png, looked at').path === 'shots/trail-held.png' && fmt.proofKind('committed a41c9e2').type === 'text');
check('a brief with no ## Plan gets one before Next step; one with an empty ## Plan gets the plan in it', (() => {
  const a = fmt.insertPlan('# X\n\n## Plan\n\n## Next step\nGo.\n', '### P\nRuns on its own.\n\n- [ ] Do: a');
  const c = fmt.insertPlan('# X\n\n## Notes\n- n\n', '### P\nRuns on its own.\n\n- [ ] Do: a');
  return a === '# X\n\n## Plan\n### P\nRuns on its own.\n\n- [ ] Do: a\n\n## Next step\nGo.\n' && c === '# X\n\n## Plan\n### P\nRuns on its own.\n\n- [ ] Do: a\n\n## Notes\n- n\n';
})());

// ---------------------------------------------------------------- the draft schema
const rules = new Map([['R1', 'Pictures first.'], ['R2', 'Prod on his call.']]);
const good = { title: 'Long notes \u2014 on the paths', reply: 'Here is a draft plan.', steps: [
  { id: 'new', kind: 'do', text: 'Research', detail: 'One line per game', arms: [], choices: [], rule: '' },
  { id: 'new', kind: 'branch', text: 'Which?', detail: '', arms: [{ if: 'If a trail', then: 'build it' }, { if: 'a ribbon', then: 'mock both' }], choices: [], rule: '' },
  { id: 'new', kind: 'gate', text: 'Show me a picture', detail: '', arms: [], choices: [], rule: 'r1' },
  { id: 'new', kind: 'gate', text: 'Ask me', detail: '', arms: [], choices: ['Go', 'Wait'], rule: 'R9' },
  { id: 'new', kind: 'done', text: 'Tests pass', detail: '', arms: [], choices: [], rule: '' },
], questions: [{ text: 'A?', options: ['x', 'y'] }, { text: 'B?', options: ['x', 'y', 'z', 'w'] }, { text: 'C?', options: ['x', 'y'] }] };
const v = planner.validateDraft(good, rules);
check('schema: a good draft passes', v.ok);
check('schema: em dashes are taken out', v.ok && v.value.title === 'Long notes, on the paths');
check('schema: a branch arm loses a leading "If"', v.ok && v.value.steps[1].arms[0].if === 'a trail');
check('schema: a gate with no choices gets Go ahead | Not yet', v.ok && v.value.steps[2].choices.join('|') === 'Go ahead|Not yet');
check('schema: a known rule id becomes its text; an unknown one is dropped', v.ok && v.value.steps[2].rule === 'Pictures first.' && v.value.steps[3].rule === null);
check('schema: at most two questions, at most three answers each', v.ok && v.value.questions.length === 2 && v.value.questions[1].options.length === 3);
check('schema: a bad kind is refused', !planner.validateDraft({ ...good, steps: [{ ...good.steps[0], kind: 'maybe' }] }).ok);
check('schema: a branch with one arm is refused', !planner.validateDraft({ ...good, steps: [{ ...good.steps[1], arms: [{ if: 'a', then: 'b' }] }] }).ok);
check('schema: no steps is refused', !planner.validateDraft({ ...good, steps: [] }).ok);
check('schema: no title is refused', !planner.validateDraft({ ...good, title: ' ' }).ok);
check('schema: not an object is refused', !planner.validateDraft('a plan').ok && !planner.validateDraft(null).ok);
check('schema: the JSON schema the CLI gets asks for every field', planner.SCHEMA.required.join() === 'title,reply,steps,questions' && planner.SCHEMA.properties.steps.items.required.length === 7);

// ---------------------------------------------------------------- revisions
const s = (id, text, extra = {}) => ({ id, kind: 'do', text, detail: '', arms: [], choices: [], rule: null, ...extra });
const r1 = planner.markChanges(
  [s('s1', 'Research 8 games'), s('s2', 'Build'), s('s3', 'Install')],
  [s('s1', 'Research 12 games'), s('s2', 'Build'), s('new', 'Stop at the editor')],
);
check('revision: a changed step is Updated, a new one Added, an unchanged one unmarked', r1.marks.s1 === 'upd' && !r1.marks.s2 && r1.marks[r1.steps[2].id] === 'add' && Object.keys(r1.marks).length === 2);
check('revision: a dropped step is counted as removed', r1.removed.join() === 's3');
check('revision: a new step gets a fresh id', r1.steps[2].id === 's4');
const r2 = planner.markChanges([s('s1', 'A'), s('s2', 'B')], [s('new', 'B'), s('new', 'A')]);
check('revision: a step returned unchanged under "new" keeps its id and no mark (a move is not a change)', r2.steps.map((x) => x.id).join() === 's2,s1' && !Object.keys(r2.marks).length);
const r3 = planner.markChanges([s('s1', 'A', { kind: 'gate', choices: ['x', 'y'] })], [s('s1', 'A', { kind: 'gate', choices: ['x', 'z'] })]);
check('revision: a gate whose choices changed is Updated', r3.marks.s1 === 'upd');

// ---------------------------------------------------------------- the alert
const hits = [];
const stub = http.createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c; }); req.on('end', () => { hits.push(JSON.parse(d)); res.end('{}'); }); });
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
fs.writeFileSync(path.join(MC, 'alerts.json'), JSON.stringify({ enabled: true, channel: 'webhook', webhook: { url: `http://127.0.0.1:${stub.address().port}/api/webhooks/1/stub` } }));
const proj = (state, planGate) => ({ id: 'boat', name: 'Paper Boat', state, primary: 'sf', planGate, workspaces: [], sessions: [{ surfaceId: 'sf', sessionId: 'sid', state: 'asked', since: '2026-11-03T17:06:00Z', words: {} }] });
const gp = proj('you', { n: 5, question: 'Install it on the headset now?', short: 'install it on the headset now?' });
check('alert kind: a plan at a gate is kind gate, before the session\'s own question', alerts.kindOf(gp) === 'gate');
check('alert text: "Plan gate: <short question>"', alerts.kindText('gate', gp) === 'Plan gate: install it on the headset now?');
check('alert kind: without a gate the session\'s kind as before', alerts.kindOf(proj('you', null)) === 'question');
alerts.observe([proj('work', null)], { now: Date.now() });
const sent = alerts.observe([gp], { now: Date.now() + 10, boardUrl: 'http://board/' });
check('moving into Needs you at a gate starts one alert, kind gate', sent.length === 1 && sent[0].kind === 'gate' && sent[0].title === 'Paper Boat needs you' && sent[0].body === 'Plan gate: install it on the headset now?');
for (let k = 0; k < 50 && !hits.length; k++) await new Promise((r) => setTimeout(r, 20));
check('the alert reaches the stub channel with only the gate\'s question', hits.length === 1 && hits[0].content.includes('Paper Boat needs you') && hits[0].content.includes('Plan gate: install it on the headset now?'), JSON.stringify(hits[0] || {}).slice(0, 200));
stub.close();

// ---------------------------------------------------------------- the Objectives row
const gp2 = fmt.derive(p);
const m1 = view.rowModel(gp2);
check('row: a dot per step, the branch as a fork, the gate as a diamond waiting on you', m1.dots.join(' ') === 'x b x x G o');
check('row: "Step 5 of 6", "At a gate: ..." in orange, with the orange wash', m1.count === 'Step 5 of 6' && m1.next.cls === 'you' && m1.next.text === 'At a gate: install it on the headset now?' && m1.wash === 'gate');
const m2 = view.rowModel(fmt.derive(fmt.parsePlanBlock('Nightfall', ['Runs on its own.', '- [x] Do: A', '- [x] Do: B', '- [ ] Done when: The end screen fits 720 by 450', '- [ ] Gate: Ship it?', '- [ ] Do: C']), { working: true }));
check('row: running shows "Running: done when ..." in blue, no wash', m2.dots.join(' ') === 'x x n g o' && m2.count === 'Step 3 of 5' && m2.next.cls === 'now' && m2.next.text === 'Running: done when the end screen fits 720 by 450' && !m2.wash);
const m3 = view.rowModel(fmt.derive(odd));
check('row: stopped to ask says so', m3.next.text.startsWith('Stopped to ask: ') && m3.dots[1] === 'y');
const fl = view.flowItems(gp2);
check('flow: the hand-off line sits before the step the fresh session started', fl.findIndex((x) => x.type === 'handoff') === 3 && fl[4].step.n === 4);
check('flow: the line under a done step into a done one is green', fl[0].ld === true && fl[fl.length - 1].ld === false);
check('gate tiles: the last proofs before the gate and the newest screenshot', (() => { const t = view.gateTiles(gp2); return t.length === 3 && t[t.length - 1].type === 'shot' && t[0].type !== 'shot'; })());

fs.rmSync(MC, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
