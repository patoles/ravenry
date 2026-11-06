#!/usr/bin/env node
// Stands in for /bin/ps and /usr/sbin/lsof on a demo or test board
// (MC_PS_BIN, MC_LSOF_BIN), so the board lists made-up Claude processes
// instead of this Mac's own. STUB_PS_STATE is a JSON file:
//   [{ "pid": 501, "ppid": 1, "rssKb": 412000, "startedAt": "<ISO>",
//      "command": "claude --resume <session id>", "cwd": "<folder>",
//      "env": "CMUX_SURFACE_ID=<id>" (optional: what `ps -E` adds after argv) }]
// It answers the calls server/sessions.mjs makes: the process list
// (`-o pid=,ppid=,rss=,lstart=,command=`, all or `-p <pids>`), the
// environment (`-E`, nothing beyond argv here) and lsof's working folders
// (`-Fn`).
import fs from 'node:fs';

const args = process.argv.slice(2);
let procs = [];
try { procs = JSON.parse(fs.readFileSync(process.env.STUB_PS_STATE, 'utf8')); } catch { /* none */ }
const pi = args.indexOf('-p');
if (pi >= 0) { const want = new Set(args[pi + 1].split(',').map(Number)); procs = procs.filter((p) => want.has(p.pid)); }
const lstart = (iso) => {
  const d = new Date(iso);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  const t = [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
  return `${day} ${mon} ${String(d.getDate()).padStart(2, ' ')} ${t} ${d.getFullYear()}`;
};
let out = '';
if (args.includes('-Fn')) for (const p of procs) out += `p${p.pid}\nfcwd\nn${p.cwd}\n`;
else if (args.includes('-E')) for (const p of procs) out += `${p.pid} ${p.command}${p.env ? ' ' + p.env : ''}\n`;
else for (const p of procs) out += `${String(p.pid).padStart(5)} ${String(p.ppid || 1).padStart(5)} ${String(p.rssKb).padStart(7)} ${lstart(p.startedAt)} ${p.command}\n`;
process.stdout.write(out);
