#!/usr/bin/env node
// A stand-in for `claude -p ... --model sonnet --output-format json` in the
// idea mockup tests: reads the prompt on stdin and answers like claude's
// JSON envelope, at once, so no test spends quota. Words in the user's note
// pick the answer: BADJSON (prose, not 3 pictures), SLOW (hangs, to prove
// the time-out and Stop), ISERROR (claude reports an error). Each call's
// argv and prompt are appended to STUB_PROMPT_LOG when it is set.
import fs from 'node:fs';

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (process.env.STUB_PROMPT_LOG) fs.appendFileSync(process.env.STUB_PROMPT_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), prompt: input }) + '\n');
  const note = (input.match(/^The user's note for this round: "(.*)"$/m) || [])[1] || '';
  const env = (result, extra = {}) => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1234, result, total_cost_usd: 0.0123, usage: { input_tokens: 2, cache_creation_input_tokens: 1500, cache_read_input_tokens: 500, output_tokens: 3000, output_tokens_details: { thinking_tokens: 1000 } }, modelUsage: { 'claude-sonnet-stub': {} }, ...extra }), () => process.exit(0));
  if (/SLOW/.test(note)) { setTimeout(() => {}, 120000); return; }
  if (/BADJSON/.test(note)) return env('Here are three ideas: a top view, a side view and a close-up.');
  if (/ISERROR/.test(note)) return env('API Error: overloaded', { is_error: true, subtype: 'error_during_execution' });
  const round = (input.match(/^Round (\d+) made 3 variants/m) || [])[1];
  const colours = ['#C0392B', '#2471A3', '#229954'];
  const vs = ['Top View', 'Low Angle', 'Close Up'].map((t, k) => ({
    title: round ? `${t} Again` : t,
    note: `Stub variant ${k + 1}${note ? ` for "${note}"` : ''}.`,
    html: `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:800px;height:500px;overflow:hidden;background:#1d1d1f}</style></head><body><svg width="800" height="500" viewBox="0 0 800 500"><rect width="800" height="500" fill="${colours[k]}"/><circle cx="400" cy="250" r="${120 + 30 * k}" fill="#F5E6C8"/><text x="40" y="70" font-size="40" fill="#FFFFFF" font-family="Georgia">${t}</text></svg><script>document.body.style.background='red'</script><img src="https://example.com/x.png"></body></html>`,
  }));
  env(JSON.stringify(vs));
});
