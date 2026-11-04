#!/usr/bin/env node
// Stands in for `codex` in the tests (MC_CODEX_BIN), so no test spends
// quota: `codex exec --json ... -` answers in Codex 0.166.0's JSONL
// (thread.started, turn.started, item.completed agent_message,
// turn.completed with usage), and `codex debug models` lists a catalogue.
//
// Each exec run appends { argv, cwd, env, prompt } to STUB_CODEX_ARGV_FILE.
// The answer follows the prompt: the repeats detector's classify and draft
// answers (with --output-schema, as tools/stub-repeats-claude.mjs), a plan
// (with --output-schema), 3 directions, 3 mockup variants, else one line
// of text. STUB_CODEX_REFUSE=<model>
// refuses a run with no -m as Codex does a model the account cannot use;
// STUB_CODEX_UNKNOWN=<feature> errors on `--disable <feature>` as a Codex
// without that feature does. "SLOW" in the prompt makes it hang.
import fs from 'node:fs';

const argv = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

if (argv[0] === 'debug' && argv[1] === 'models') {
  process.stdout.write(JSON.stringify({ models: [
    { slug: 'gpt-reserve', visibility: 'hide', priority: 4 },
    { slug: 'gpt-6-luna', visibility: 'list', priority: 5 },
    { slug: 'gpt-5.6-luna', visibility: 'list', priority: 9 },
  ] }));
  process.exit(0);
}
if (argv[0] !== 'exec') {
  process.stderr.write('stub-codex: only exec and debug models\n');
  process.exit(2);
}

const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (process.env.STUB_CODEX_ARGV_FILE) {
    const env = Object.fromEntries(['CMUX_CODEX_HOOKS_DISABLED', 'CODEX_HOME', 'MC_PLAN_JOB', 'MC_IDEA_JOB', 'MC_REPEATS_JOB'].map((k) => [k, process.env[k] ?? null]));
    const sf = opt('--output-schema');
    let schema = null;
    try { schema = sf ? JSON.parse(fs.readFileSync(sf, 'utf8')) : null; } catch { /* unreadable */ }
    fs.appendFileSync(process.env.STUB_CODEX_ARGV_FILE, JSON.stringify({ argv, cwd: process.cwd(), env, prompt: input, schema }) + '\n');
  }
  const unknown = process.env.STUB_CODEX_UNKNOWN;
  if (unknown && argv.some((a, i) => a === '--disable' && argv[i + 1] === unknown)) {
    process.stderr.write(`Error: Unknown feature flag: ${unknown}\n`);
    process.exit(1);
  }
  out({ type: 'thread.started', thread_id: '00000000-stub-4000-8000-000000000000' });
  const refuse = process.env.STUB_CODEX_REFUSE;
  if (refuse && !opt('-m')) {
    out({ type: 'turn.started' });
    const message = `The '${refuse}' model is not supported when using Codex with a ChatGPT account.`;
    out({ type: 'error', message });
    out({ type: 'turn.failed', error: { message } });
    process.exit(1);
  }
  if (/SLOW/.test(input)) { setTimeout(() => {}, 600000); return; }
  out({ type: 'turn.started' });
  let text;
  if (opt('--output-schema') && /find the corrections they make again and again/.test(input)) {
    // The repeats detector, as tools/stub-repeats-claude.mjs answers it,
    // with every field the strict schema requires.
    if (!/Clusters:\n/.test(input)) {
      const items = [];
      for (const m of input.matchAll(/^\[(\d+)\] \([^)]*\) (.*)$/gm)) {
        const k = Number(m[1]);
        const nw = m[2].match(/STUB:new:([a-z0-9-]+)/);
        const ex = m[2].match(/STUB:([a-z0-9-]+)/);
        if (nw) items.push({ k, v: 'new', cluster: nw[1], gist: `Gist for ${nw[1]}`, also: [] });
        else if (ex) items.push({ k, v: 'existing', cluster: ex[1], gist: '', also: [] });
        else items.push({ k, v: 'none', cluster: '', gist: '', also: [] });
      }
      text = JSON.stringify({ items });
    } else {
      const drafts = [];
      for (const m of input.matchAll(/^## ([a-z0-9-]+) /gm)) {
        const id = m[1];
        const match = id.includes('agentsline') ? 'Q1' : id.includes('reword') ? 'G1' : id.includes('memory') ? 'M1' : '';
        drafts.push({ id, rule: `Codex rule for ${id}`, match, line: `- Codex line for ${id}`, quote: { k: 0, sentence: 0 } });
      }
      text = JSON.stringify({ drafts });
    }
  } else if (opt('--output-schema')) {
    const ruleId = (re) => { const m = input.split('\n').find((l) => /^R\d+ /.test(l) && re.test(l)); return m ? m.split(' ')[0] : ''; };
    if (/Revise the plan/.test(input)) {
      const at = input.indexOf('The plan now (JSON):') + 20;
      const steps = JSON.parse(input.slice(at, input.indexOf('\n]', at) + 2));
      steps.push({ id: 'new', kind: 'do', text: 'Do the change the user asked for', detail: '', arms: [], choices: [], rule: '' });
      text = JSON.stringify({ title: 'Codex stub plan', reply: 'Added your change as a step.', steps, questions: [] });
    } else {
      text = JSON.stringify({
        title: 'Codex stub plan',
        reply: 'Here is a draft plan.',
        steps: [
          { id: 'new', kind: 'do', text: 'Look at how it works now', detail: '', arms: [], choices: [], rule: '' },
          { id: 'new', kind: 'gate', text: 'Show a picture before building anything visual', detail: '', arms: [], choices: ['Looks right', 'Change it'], rule: ruleId(/picture|mockup/i) },
          { id: 'new', kind: 'do', text: 'Build it', detail: '', arms: [], choices: [], rule: '' },
          { id: 'new', kind: 'done', text: 'The test passes', detail: '', arms: [], choices: [], rule: '' },
        ],
        questions: [],
      });
    }
  } else if (/exactly 3 distinct directions/.test(input)) {
    const seed = (input.match(/for this seed: "([^"]*)"/) || [])[1] || 'the seed';
    text = JSON.stringify([1, 2, 3].map((n) => ({ name: `Codex ${n}`, pitch: `Direction ${n} for ${seed}.` })));
  } else if (/quick visual mockup/.test(input)) {
    text = JSON.stringify(['a', 'b', 'c'].map((k) => ({ title: `Codex ${k}`, note: `Variant ${k}.`, html: `<!doctype html><body style="margin:0;background:#123"><div style="color:#fff">${k}</div></body>` })));
  } else {
    const last = (input.match(/The user now says: (.*)/) || [])[1] || '';
    text = `Codex stub reply (cwd ${process.cwd().split('/').slice(-1)[0]}): ${last}`;
  }
  out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } });
  out({ type: 'turn.completed', usage: { input_tokens: 1234, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 56, reasoning_output_tokens: 7 } });
});
