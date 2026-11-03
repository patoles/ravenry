#!/usr/bin/env node
// Stands in for `claude -p ... --output-format json --json-schema` in the
// plans tests and screenshots (MC_PLAN_COMMAND), so they spend no quota.
// A first draft is the mockup's plan, with two questions and the
// rule about pictures as a gate; a revision answers the comment on step 1
// (12 games) and "Stop at the editor" (the install gate goes). STUB_PLAN_DELAY_MS
// slows it down for the "drafting" screenshots.
import fs from 'node:fs';

const args = process.argv.slice(2);
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  const ruleId = (re) => { const m = input.split('\n').find((l) => /^R\d+ /.test(l) && re.test(l)); return m ? m.split(' ')[0] : ''; };
  const pic = ruleId(/picture|mockup|look/i);
  let out;
  if (/Revise the plan/.test(input)) {
    const cur = JSON.parse(input.slice(input.indexOf('The plan now (JSON):') + 20, input.indexOf('\n]', input.indexOf('The plan now (JSON):')) + 2));
    let steps = cur.map((s) => ({ ...s }));
    const notes = [];
    if (/Comment on step 1/.test(input) && steps[0]) { steps[0].text = steps[0].text.replace(/\b8\b/, '12'); notes.push('Research now covers 12 games.'); }
    if (/-> Stop at the editor/.test(input)) {
      steps = steps.filter((s) => !/install/i.test(s.text));
      steps.push({ id: 'new', kind: 'do', text: 'Stop at the editor, no install', detail: 'Leave it committed and send you the screenshot', arms: [], choices: [], rule: '' });
      notes.push('Added: stop at the editor, no install, so the install gate is gone.');
    }
    const ask = input.match(/He asks for these changes:\n- (.*)/);
    if (ask && !/Comment on step/.test(ask[1])) { steps.push({ id: 'new', kind: 'do', text: ask[1].slice(0, 80), detail: '', arms: [], choices: [], rule: '' }); notes.push('Added your change as a step.'); }
    out = { title: 'Long notes on the paths', reply: notes.join(' ') || 'Nothing to change.', steps, questions: [] };
  } else {
    const own = /His words: "/.test(input);
    out = {
      title: 'Long notes on the paths',
      reply: own ? 'Here are your steps.' : 'Here is a draft plan. Two questions first, because a wrong guess would change the steps:',
      steps: [
        { id: 'new', kind: 'do', text: 'Research how 8 rhythm games show long notes', detail: 'One line per game, with a picture, in docs/research/long-notes.md', arms: [], choices: [], rule: '' },
        { id: 'new', kind: 'branch', text: 'What do most of them use?', detail: '', arms: [{ if: 'a held trail', then: 'build the trail' }, { if: 'a ribbon', then: 'mock up the trail and the ribbon side by side' }], choices: [], rule: '' },
        { id: 'new', kind: 'gate', text: 'Show me a picture before building anything visual', detail: 'A mockup of the chosen look; waits for your OK', arms: [], choices: ['Looks right', 'Change it'], rule: pic },
        { id: 'new', kind: 'do', text: 'Build the held trail on the path notes', detail: '', arms: [], choices: [], rule: '' },
        { id: 'new', kind: 'done', text: 'The gesture test passes in the editor, and a screenshot shows the trail', detail: '', arms: [], choices: [], rule: '' },
        { id: 'new', kind: 'gate', text: 'Ask me before installing on the headset', detail: '', arms: [], choices: ['Install on the headset', 'Not yet'], rule: ruleId(/install|device|adb|headset/i) },
        { id: 'new', kind: 'do', text: 'Install on the headset', detail: '', arms: [], choices: [], rule: '' },
      ],
      questions: own ? [] : [
        { text: 'Install on the headset at the end, or stop at the editor?', options: ['Install, after asking me', 'Stop at the editor'] },
        { text: 'Held notes on the paths only, or the legato line too?', options: ['Held notes only', 'The legato line too'] },
      ],
    };
  }
  // STUB_PLAN_ARGV_FILE: one JSON line per call with its argv, working
  // folder and prompt, so a test can check what the board ran.
  if (process.env.STUB_PLAN_ARGV_FILE) fs.appendFileSync(process.env.STUB_PLAN_ARGV_FILE, JSON.stringify({ argv: args, cwd: process.cwd(), prompt: input }) + '\n');
  const reply = () => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(out), structured_output: out, usage: { input_tokens: 4100, output_tokens: 620, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, total_cost_usd: 0, modelUsage: { 'stub-sonnet': {} }, argv: args.length }));
  setTimeout(reply, Number(process.env.STUB_PLAN_DELAY_MS) || 0);
});
