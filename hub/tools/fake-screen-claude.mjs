// A stand-in Claude Code that only draws a screen, for checks of the Live
// screen in a real Ravenry pane (tools/phone-links-test.mjs). Never run it
// in a real pane.
//
//   node tools/fake-screen-claude.mjs <screen.json> --session-id <id>
//
// - It lists itself in the test account's stub process list
//   (<HOME>/../stub-ps.json, read through tools/stub-ps.mjs) as
//   `claude --session-id <id>`, so the board takes its pane for a Claude
//   Code session, and takes itself out when it ends.
// - It draws <screen.json>'s `lines` (raw: escape sequences such as an OSC 8
//   hyperlink are written as they are) above Claude Code's prompt box, and
//   draws them again whenever the file changes, so a check can feed new
//   lines while the board reads the pane.
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const FILE = args[0];
const sid = args[args.indexOf('--session-id') + 1];
const PS = path.join(path.dirname(process.env.HOME), 'stub-ps.json');

function editPs(fn) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(PS, 'utf8')); } catch { /* none yet */ }
  const tmp = `${PS}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(fn(list))); fs.renameSync(tmp, PS); } catch { /* no list */ }
}
const envWords = Object.keys(process.env).filter((k) => ['TERM_PROGRAM', 'RAVENRY_PANE'].includes(k)).sort().map((k) => `${k}=${process.env[k]}`).join(' ');
editPs((l) => [...l.filter((p) => p.pid !== process.pid), { pid: process.pid, ppid: process.ppid, rssKb: 120000, startedAt: new Date().toISOString(), command: `claude --session-id ${sid}`, cwd: process.cwd(), env: envWords }]);
const leave = () => { editPs((l) => l.filter((p) => p.pid !== process.pid)); process.exit(0); };
for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, leave);

const W = Math.max(40, Math.min(process.stdout.columns || 100, 140));
const RULE = '─'.repeat(W);
let last = null;
function draw() {
  let text;
  try { text = fs.readFileSync(FILE, 'utf8'); } catch { return; }
  if (text === last) return;
  last = text;
  const { lines } = JSON.parse(text);
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H' + lines.join('\r\n') + `\r\n\r\n${RULE}\r\n❯ \r\n${RULE}\r\n  ⏵⏵ auto mode on\x1b[2A\x1b[3G`);
}
draw();
setInterval(draw, 150);
