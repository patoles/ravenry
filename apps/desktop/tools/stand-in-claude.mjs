// A stand-in Claude Code for the release check (tools/release-check.mjs):
// a real process with a real pid, as `claude` on the test account's PATH.
//
//   - it lists itself in the account's stub process list (<HOME>/../stub-ps.json,
//     which the hub reads through tools/stub-ps.mjs) with its pid, its
//     arguments and the terminal variables it was started with, and takes
//     itself out when it exits;
//   - it runs the hooks of <HOME>/.claude/settings.json as Claude Code does,
//     through /bin/sh -c with the event's JSON on stdin: SessionStart, then
//     for each line typed UserPromptSubmit and Stop, and SessionEnd when its
//     input ends;
//   - it writes the session's transcript (~/.claude/projects/<folder>/<id>.jsonl)
//     and says, when it starts, the last answer in it ("last turn: ...");
//   - a prompt with "slow" in it keeps the turn running for
//     STAND_IN_SLOW_MS (8 s by default) before its answer and Stop.
//
// `claude --version`, `claude --resume <id>`, `claude --session-id <id>`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.319 (Claude Code)'); process.exit(0); }
const HOME = process.env.HOME;
const PS = path.join(path.dirname(HOME), 'stub-ps.json');
const after = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const sid = after('--resume') || after('--session-id') || crypto.randomUUID();
const cwd = process.cwd();
// Its transcript: the one this session id already has (resumed from another
// folder spelling, /var or /private/var), else one for this folder.
const TR = (() => {
  const root = path.join(HOME, '.claude', 'projects');
  try { for (const d of fs.readdirSync(root)) if (fs.existsSync(path.join(root, d, `${sid}.jsonl`))) return path.join(root, d, `${sid}.jsonl`); } catch { /* none yet */ }
  return path.join(root, cwd.replace(/[^A-Za-z0-9-]/g, '-'), `${sid}.jsonl`);
})();

// The stub process list, written whole (a new file renamed over it).
function editPs(fn) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(PS, 'utf8')); } catch { /* none */ }
  const tmp = `${PS}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(fn(list))); fs.renameSync(tmp, PS); } catch { /* no list: a plain run */ }
}
const envWords = ['TERM_PROGRAM', 'RAVENRY_PANE', 'CMUX_WORKSPACE_ID', 'CMUX_SURFACE_ID', 'ITERM_SESSION_ID']
  .filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]}`).join(' ');
editPs((l) => [...l.filter((p) => p.pid !== process.pid), { pid: process.pid, ppid: process.ppid, rssKb: 120000, startedAt: new Date().toISOString(), command: `claude ${args.join(' ')}`.trim(), cwd, env: envWords }]);
let gone = false;
const leave = (code = 0) => { if (!gone) { gone = true; editPs((l) => l.filter((p) => p.pid !== process.pid)); } process.exit(code); };
for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) process.on(sig, () => leave(0));

function hooks(event, extra = {}) {
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8')); } catch { return; }
  const input = JSON.stringify({ session_id: sid, hook_event_name: event, cwd, transcript_path: TR, ...extra });
  for (const e of (settings.hooks && settings.hooks[event]) || []) for (const h of e.hooks || []) {
    if (h.type !== 'command' || !h.command) continue;
    const r = spawnSync('/bin/sh', ['-c', h.command], { input, env: process.env, encoding: 'utf8', timeout: (h.timeout || 10) * 1000 });
    // As Claude Code shows it: a hook that failed is said on the screen.
    if (r.status !== 0 && r.status !== 2) process.stdout.write(`${event} hook error: ${(r.stderr || '').trim().split('\n')[0]}\n`);
  }
}

function record(type, extra) {
  fs.mkdirSync(path.dirname(TR), { recursive: true });
  fs.appendFileSync(TR, JSON.stringify({ type, cwd, sessionId: sid, timestamp: new Date().toISOString(), ...extra }) + '\n');
}
function lastAnswer() {
  try {
    const lines = fs.readFileSync(TR, 'utf8').trim().split('\n').reverse();
    for (const l of lines) { const r = JSON.parse(l); if (r.type === 'assistant') return (r.message.content.find((c) => c.type === 'text') || {}).text || null; }
  } catch { /* no transcript yet */ }
  return null;
}

console.log(`fake claude ready (args: ${args.join(' ')})`);
const last = lastAnswer();
if (last) console.log(`last turn: ${last}`);
hooks('SessionStart', { source: after('--resume') ? 'resume' : 'startup' });

let turn = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const prompt = line.trim();
  if (!prompt) return;
  turn = turn.then(async () => {
    hooks('UserPromptSubmit', { prompt });
    record('user', { message: { role: 'user', content: prompt } });
    console.log(`thinking: ${prompt}`);
    if (/slow/.test(prompt)) await new Promise((r) => setTimeout(r, Number(process.env.STAND_IN_SLOW_MS) || 8000));
    const answer = `answer to: ${prompt}`;
    record('assistant', { message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: answer }], usage: { input_tokens: 5, cache_read_input_tokens: 40000, output_tokens: 20 } } });
    console.log(`answered: ${prompt}`);
    hooks('Stop', { stop_hook_active: false });
  });
});
rl.on('close', () => { void turn.then(() => { hooks('SessionEnd', { reason: 'exit' }); leave(0); }); });
