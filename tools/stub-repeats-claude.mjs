// Stands in for `claude -p ... --output-format json --json-schema` in the
// repeats tests, so they spend no quota. Classify: a message holding
// "STUB:new:<id>" starts cluster <id>, "STUB:<id>" joins it, anything else is
// not a correction. Draft: a cluster whose id holds "reword" matches G1,
// one holding "memory" matches M1, the rest match nothing.
const args = process.argv.slice(2);
const schema = args[args.indexOf('--json-schema') + 1] || '';
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let out;
  if (!schema.includes('"drafts"')) {
    const items = [];
    for (const m of input.matchAll(/^\[(\d+)\] \([^)]*\) (.*)$/gm)) {
      const k = Number(m[1]);
      const nw = m[2].match(/STUB:new:([a-z0-9-]+)/);
      const ex = m[2].match(/STUB:([a-z0-9-]+)/);
      if (nw) items.push({ k, v: 'new', cluster: nw[1], gist: `Gist for ${nw[1]}` });
      else if (ex) items.push({ k, v: 'existing', cluster: ex[1] });
      else items.push({ k, v: 'none' });
    }
    out = { items };
  } else {
    const drafts = [];
    for (const m of input.matchAll(/^## ([a-z0-9-]+) /gm)) {
      const id = m[1];
      drafts.push({ id, rule: `Stub rule for ${id}`, match: id.includes('reword') ? 'G1' : id.includes('memory') ? 'M1' : '', line: `- Stub line for ${id} (stub-name)`, quote: { k: 0, sentence: 1 } });
    }
    out = { drafts };
  }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(out), structured_output: out, usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, total_cost_usd: 0 }));
});
