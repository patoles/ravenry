// A stand-in for `claude -p` in the phase D tests: reads the prompt on stdin
// and answers at once, so no test spends real quota. "SLOW" in the message
// makes it hang, to prove the time-out.
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (/exactly 3 distinct directions/.test(input)) {
    const seed = (input.match(/for this seed: "([^"]*)"/) || [])[1] || 'the seed';
    process.stdout.write(JSON.stringify([
      { name: 'Stub One', pitch: `First direction for ${seed}.` },
      { name: 'Stub Two', pitch: `Second direction for ${seed}.` },
      { name: 'Stub Three', pitch: `Third direction for ${seed}.` },
    ]));
    return;
  }
  const last = (input.match(/The user now says: (.*)/) || [])[1] || '';
  if (/SLOW/.test(last)) { setTimeout(() => {}, 120000); return; }
  const stage = (input.match(/^Stage: (.*)$/m) || [])[1];
  process.stdout.write(`Stub reply (stage ${stage}, cwd ${process.cwd().split('/').slice(-2).join('/')}): ${last}`);
});
