// A stand-in for Claude Code's prompt, for the phase B send test only.
// It draws the same "────\n❯ \n────" box the screen parser looks for and
// prints every line it receives above it, so `cmux read-screen` can prove
// what arrived. Run it in a scratch cmux workspace, never in a real one.
import readline from 'node:readline';

const W = Math.max(40, Math.min(process.stdout.columns || 100, 140));
const RULE = '─'.repeat(W);
const got = [];

function draw() {
  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write('fake claude for ravenry tests\n\n');
  for (const l of got.slice(-12)) process.stdout.write(`⏺ received: ${l}\n`);
  if (got.length) process.stdout.write(`✻ Worked for 1s · done ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}\n`);
  process.stdout.write(`\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ fake prompt (ravenry test)\x1b[2A\x1b[3G`);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => { got.push(line); draw(); });
draw();
