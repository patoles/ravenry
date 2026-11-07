// Every ravenryd and hub a test tool starts stops when the tool ends,
// however it ends (tools/test-env.mjs, reapStarted): on 2026-11-07 five test
// daemons and a test hub from runs the day before were still running, each
// left by a tool that a signal or a time-out stopped before its own
// clean-up. A child tool here starts a stand-in hub (a script at
// .../server/index.mjs), a ravenryd in the foreground and one with
// `serve --detach` (not its child), then ends three ways: SIGTERM, an
// uncaught error, and process.exit at its end. Each time nothing it started is left.
//
// Usage: RAVENRYD_BIN=../daemon/ravenryd node tools/reap-test.mjs
// Without RAVENRYD_BIN only the stand-in hub is checked.
import './test-guard.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.dirname(ROOT);
const T = fs.mkdtempSync(path.join(ROOT, '.tmp', 'reap-'));
const BIN = process.env.RAVENRYD_BIN ? path.resolve(process.env.RAVENRYD_BIN) : null;
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const hasLsof = (() => { try { execFileSync('lsof', ['-v'], { stdio: 'ignore' }); return true; } catch (e) { return e.code !== 'ENOENT'; } })();

// The stand-in hub: a script the guard takes for a hub by its path.
const FAKE_HUB = path.join(T, 'fake', 'server', 'index.mjs');
fs.mkdirSync(path.dirname(FAKE_HUB), { recursive: true });
fs.writeFileSync(FAKE_HUB, 'setInterval(() => {}, 1000);\n');

// The tool: starts them, says their pids, then ends as told.
const TOOL = path.join(T, 'tool.mjs');
fs.writeFileSync(TOOL, `import { guardSpawns, withStubMachine } from ${JSON.stringify(path.join(REPO, 'tools', 'test-env.mjs'))};
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
guardSpawns();
const [how, home, bin, rt] = process.argv.slice(2);
const env = withStubMachine({ PATH: '/usr/bin:/bin', RAVENRY_TERMINAL: 'ravenry', HOME: home, RAVENRY_HOME: path.join(home, '.ravenry'), RAVENRY_RUNTIME_DIR: path.join(rt, 'a'), RAVENRY_STATE_DIR: path.join(home, 'state') });
const hub = spawn(process.execPath, [${JSON.stringify(FAKE_HUB)}], { env, stdio: 'ignore' });
const out = { hub: hub.pid, fg: null, rt2: null };
if (bin !== '-') {
  const fg = spawn(bin, ['serve'], { env, stdio: 'ignore' });
  out.fg = fg.pid;
  const env2 = { ...env, RAVENRY_RUNTIME_DIR: path.join(rt, 'b') };
  execFileSync(bin, ['serve', '--detach'], { env: env2, stdio: 'ignore' });
  out.rt2 = env2.RAVENRY_RUNTIME_DIR;
  for (let i = 0; i < 100 && !(fs.existsSync(env.RAVENRY_RUNTIME_DIR) && fs.readdirSync(env.RAVENRY_RUNTIME_DIR).some((n) => n.endsWith('.sock'))); i++) await new Promise((r) => setTimeout(r, 50));
}
console.log(JSON.stringify(out));
if (how === 'throw') setTimeout(() => { throw new Error('the tool failed'); }, 100);
else if (how === 'end') setTimeout(() => process.exit(0), 100);
else setInterval(() => {}, 1000);
`);

function listeners(dir) {
  if (!dir || !hasLsof) return [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.sock')); } catch { return []; }
  const pids = [];
  for (const n of names) {
    try { pids.push(...execFileSync('lsof', ['-t', '--', path.join(dir, n)], { encoding: 'utf8' }).split(/\s+/).map(Number).filter(Boolean)); } catch { /* none */ }
  }
  return pids;
}

for (const how of ['sigterm', 'throw', 'end']) {
  const home = fs.mkdtempSync(path.join(T, `h-${how}-`));
  // A short runtime folder: a unix socket's path has a length limit.
  const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'rvr-'));
  const child = spawn(process.execPath, [TOOL, how, home, BIN || '-', rt], { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  let err = '';
  child.stdout.on('data', (d) => { buf += d; });
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((r) => child.on('exit', r));
  for (let i = 0; i < 200 && !buf.includes('\n'); i++) await sleep(50);
  let pids = {};
  try { pids = JSON.parse(buf.split('\n')[0]); } catch { /* none */ }
  const detached = BIN ? listeners(pids.rt2) : [];
  check(`${how}: the tool started a hub${BIN ? ', a ravenryd and a detached one' : ''}`, pids.hub > 0 && alive(pids.hub) && (!BIN || (pids.fg > 0 && alive(pids.fg) && (!hasLsof || detached.length === 1))), buf + JSON.stringify(detached) + err.slice(-600));
  if (how === 'sigterm') child.kill('SIGTERM');
  await exited;
  await sleep(600);
  const left = [pids.hub, pids.fg, ...detached].filter((p) => p && alive(p));
  check(`${how}: when it ends, nothing it started is left`, left.length === 0, `left: ${left.join(', ')}`);
  for (const p of left) { try { process.kill(p, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(rt, { recursive: true, force: true });
}
if (!BIN) console.log('SKIP  ravenryd: set RAVENRYD_BIN to a ravenryd binary');

fs.rmSync(T, { recursive: true, force: true });
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
