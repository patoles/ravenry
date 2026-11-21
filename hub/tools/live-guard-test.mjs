// No test reaches the person's own ravenryd or board, whatever shell it is
// run from (tools/test-env.mjs, the person's own daemon and board). On
// 2026-11-21 packages/client's node test, run from a shell in a Ravenry
// pane, opened a pane in the person's daemon and typed into it: it handed
// findDaemon the RAVENRY_SOCKET it inherited.
//
// Stand-ins for the person's daemon (a unix socket) and board (an HTTP
// server) count every connection made to them. Fails when:
// - a test run with them in its environment, as a Ravenry pane's shell
//   has them (RAVENRY_SOCKET, RAVENRY_PANE, TERM_PROGRAM=ravenry,
//   RAVENRY_HUB_URL, MC_BOARD_URL), connects to either: the client's node
//   test against a real ravenryd, a client looking for its daemon as that
//   test did under each guard (hub/tools/test-guard.mjs,
//   tools/test-guard.mjs, guardSpawns alone), and the daemon's Go guard
//   (daemon/internal/testenv);
// - such a test, or a child of it, still has one of them;
// - a child given the person's socket or board is not refused;
// - the tool's own connection to the person's socket or board is not
//   refused (net, http, fetch, the client), or one to a test's socket is;
// - a test under packages/*/test that talks to a daemon does not import
//   a guard first.
// A control run with no guard must reach the stand-in, or the check
// proves nothing.
//
// Usage: node tools/live-guard-test.mjs
// The real ravenryd: RAVENRYD_BIN, RAVENRYD, else ../daemon/ravenryd when
// built; without one the client's real-daemon test is skipped. Without Go
// the Go row is skipped. Touches only .tmp/ and the system's temporary folder.
import './test-guard.mjs';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LIVE_VARS, markLive, personBoard, personSocket, REAL_HOME } from '../../tools/test-env.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.dirname(ROOT);
const T = path.join(ROOT, '.tmp', 'live-guard-test');
fs.rmSync(T, { recursive: true, force: true });
fs.mkdirSync(T, { recursive: true });
// Short: a unix socket's path has a length limit.
const SHORT = fs.mkdtempSync(path.join(os.tmpdir(), 'rvlg-'));
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  ' + String(detail).slice(0, 1500) : ''}`); if (!ok) fails++; return ok; };
const VARS = [...LIVE_VARS, 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION'];
const BIN = [process.env.RAVENRYD_BIN, process.env.RAVENRYD, path.join(REPO, 'daemon', 'ravenryd')].filter(Boolean).map((b) => path.resolve(b)).find((b) => fs.existsSync(b)) || null;

// ------------------------------------------------------------ the stand-ins
const LIVE_SOCK = path.join(SHORT, 'ravenryd-9.9.9.sock');
let sockHits = 0;
const daemon = net.createServer((c) => { sockHits++; c.destroy(); });
await new Promise((r) => daemon.listen(LIVE_SOCK, r));
let boardHits = 0;
const board = http.createServer((req, res) => res.end('{}'));
board.on('connection', () => { boardHits++; });
await new Promise((r) => board.listen(0, '127.0.0.1', r));
const BOARD = `http://127.0.0.1:${board.address().port}`;
// What a shell in a Ravenry pane has, pointing at the stand-ins.
const SHELL_VARS = { RAVENRY_SOCKET: LIVE_SOCK, RAVENRY_PANE: 'plive001', TERM_PROGRAM: 'ravenry', TERM_PROGRAM_VERSION: '0.1.0', RAVENRY_HUB_URL: BOARD, MC_BOARD_URL: BOARD };
const fromPane = { ...process.env, ...SHELL_VARS };
const hits = () => sockHits + boardHits;

// Children run while this process keeps answering for the stand-ins.
const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  const c = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { err += d; });
  const timer = setTimeout(() => c.kill('SIGKILL'), opts.timeout || 120000);
  c.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
});
const settle = () => new Promise((r) => setTimeout(r, 300));

// ------------------------------------------------------------ this test's own process
check('this test, run from a pane, keeps none of the pane\'s variables', VARS.every((k) => !(k in process.env) || (k.startsWith('TERM_PROGRAM') && process.env.TERM_PROGRAM !== 'ravenry')), VARS.filter((k) => k in process.env).join(' '));

// ------------------------------------------------------------ a client finding its daemon, as the client's test did
// Its whole environment with its own runtime folder: RAVENRY_SOCKET, when
// it is still there, wins over the folder.
const EMPTY_RT = path.join(SHORT, 'rt');
fs.mkdirSync(EMPTY_RT);
const probe = (guard) => {
  const file = path.join(T, `probe-${guard.name}.mjs`);
  fs.writeFileSync(file, `${guard.head}
import { findDaemon } from ${JSON.stringify(path.join(REPO, 'packages', 'client', 'src', 'node.ts'))};
import { spawnSync } from 'node:child_process';
const vars = ${JSON.stringify(VARS)};
const left = vars.filter((k) => k in process.env && !(k.startsWith('TERM_PROGRAM') && process.env.TERM_PROGRAM !== 'ravenry'));
const env = spawnSync('/bin/sh', ['-c', 'env'], { encoding: 'utf8' }).stdout.split('\\n').map((l) => l.split('=')[0]);
const child = vars.filter((k) => env.includes(k) && k !== 'TERM_PROGRAM_VERSION');
let found = 'none';
try {
  const d = await Promise.race([findDaemon({ name: 'live-guard-probe', env: { ...process.env, RAVENRY_RUNTIME_DIR: ${JSON.stringify(EMPTY_RT)} } }), new Promise((_, no) => setTimeout(() => no(new Error('timed out')), 5000))]);
  found = d.socket; d.client.close();
} catch (e) { found = /no ravenryd is running/.test(e.message) ? 'none' : 'error: ' + e.message; }
let reached = 'none';
const url = process.env.RAVENRY_HUB_URL || process.env.MC_BOARD_URL;
if (url) { try { await fetch(url + '/api/state'); reached = 'reached'; } catch (e) { reached = 'failed: ' + ((e.cause && e.cause.message) || e.message); } }
console.log(JSON.stringify({ left, child, found, reached }));
process.exit(0);
`);
  return run(process.execPath, [file], { cwd: T, env: fromPane, timeout: 30000 });
};
const parse = (r) => { try { return JSON.parse(r.out.trim().split('\n').pop()); } catch { return null; } };

{
  // The control: with no guard, the stand-ins are reached.
  const before = hits();
  const r = parse(await probe({ name: 'none', head: '' }));
  await settle();
  check('control: with no guard, a client run from a pane reaches the stand-in of the person\'s daemon and board', !!r && r.found !== 'none' && r.reached === 'reached' && sockHits > 0 && boardHits > 0 && hits() > before, JSON.stringify({ r, sockHits, boardHits }));
  sockHits = 0;
  boardHits = 0;
}
const GUARDS = [
  { name: 'hub', label: 'hub/tools/test-guard.mjs (every hub test)', head: `import ${JSON.stringify(path.join(ROOT, 'tools', 'test-guard.mjs'))};` },
  { name: 'packages', label: 'tools/test-guard.mjs (packages/*/test)', head: `import ${JSON.stringify(path.join(REPO, 'tools', 'test-guard.mjs'))};` },
  { name: 'spawns', label: 'guardSpawns() alone (apps/*/tools, apps/macos/scripts)', head: `import { guardSpawns } from ${JSON.stringify(path.join(REPO, 'tools', 'test-env.mjs'))};\nguardSpawns();` },
];
for (const g of GUARDS) {
  const res = await probe(g);
  const r = parse(res);
  await settle();
  check(`${g.label}: run from a pane, the test and its children keep none of the pane's variables`, !!r && r.left.length === 0 && r.child.length === 0, JSON.stringify(r) + res.err.slice(-400));
  check(`${g.label}: its client finds no daemon (not the person's) and reaches no board`, !!r && r.found === 'none' && r.reached === 'none', JSON.stringify(r) + res.err.slice(-400));
  check(`${g.label}: nothing connected to the stand-ins`, hits() === 0, JSON.stringify({ sockHits, boardHits }));
}

// ------------------------------------------------------------ the client's own test, from a pane
if (BIN) {
  const r = await run(process.execPath, ['--test', '--test-reporter=tap', path.join('test', 'node.test.ts')], { cwd: path.join(REPO, 'packages', 'client'), env: { ...fromPane, RAVENRYD: BIN }, timeout: 120000 });
  await settle();
  const n = (k) => Number((r.out.match(new RegExp(`^# ${k} (\\d+)`, 'm')) || [])[1]);
  check(`packages/client node.test.ts against ${path.relative(REPO, BIN) || BIN}, run from a pane: passes, the real daemon's test included (${n('pass')} passed, ${n('skipped')} skipped)`, r.code === 0 && n('fail') === 0 && n('skipped') === 0 && n('pass') > 0, r.out.slice(-1200) + r.err.slice(-400));
  check('and it reached neither stand-in', hits() === 0, JSON.stringify({ sockHits, boardHits }));
} else console.log('SKIP  packages/client node.test.ts against a real ravenryd: none built (RAVENRYD_BIN, or make build in daemon/)');

// ------------------------------------------------------------ the daemon's Go tests
const GO = spawnSync('/bin/sh', ['-c', 'command -v go'], { encoding: 'utf8' }).stdout.trim();
if (GO) {
  const r = await run(GO, ['test', '-count=1', '-run', 'TestThePersonsDaemonAndBoardAreOutOfReach', './internal/testenv'], { cwd: path.join(REPO, 'daemon'), env: fromPane, timeout: 300000 });
  await settle();
  check('daemon/internal/testenv, run from a pane: a Go test keeps none of the pane\'s variables and refuses the person\'s socket and board', r.code === 0 && /^ok\s/m.test(r.out), r.out.slice(-800) + r.err.slice(-800));
  check('and it reached neither stand-in', hits() === 0, JSON.stringify({ sockHits, boardHits }));
} else console.log('SKIP  the Go guard: no go on the PATH');

// ------------------------------------------------------------ the tool's own connections and children
// From here on the stand-ins are the person's, in this process.
markLive({ socket: LIVE_SOCK, port: board.address().port });
{
  const refused = (f) => { try { const s = f(); if (s && s.destroy) s.destroy(); return null; } catch (e) { return e.message; } };
  let m = refused(() => net.connect(LIVE_SOCK));
  check('net.connect to the person\'s socket is refused', /Refused to connect/.test(m || ''), m || 'it connected');
  m = refused(() => net.createConnection({ path: LIVE_SOCK }));
  check('net.createConnection({ path }) too', /Refused to connect/.test(m || ''), m || 'it connected');
  m = await fetch(BOARD + '/api/state').then(() => null, (e) => (e.cause && e.cause.message) || e.message);
  check('fetch to the person\'s board is refused', /Refused to connect/.test(m || ''), m || 'it answered');
  m = await new Promise((resolve) => { try { http.get(BOARD + '/api/state', () => resolve(null)).on('error', (e) => resolve(e.message)); } catch (e) { resolve(e.message); } });
  check('http.get to the person\'s board too', /Refused to connect/.test(m || ''), m || 'it answered');
  const { findDaemon } = await import(path.join(REPO, 'packages', 'client', 'src', 'node.ts'));
  m = await findDaemon({ name: 'live-guard', socket: LIVE_SOCK }).then((d) => { d.client.close(); return null; }, (e) => e.message);
  check('the client pinned to the person\'s socket is refused', /Refused to connect/.test(m || ''), m || 'it connected');
  await new Promise((r) => setTimeout(r, 300));
  check('nothing connected to the stand-ins', hits() === 0, JSON.stringify({ sockHits, boardHits }));

  // A test's own socket and board stay reachable.
  const OWN = path.join(SHORT, 'own.sock');
  let ownHits = 0;
  const own = net.createServer((c) => { ownHits++; c.destroy(); });
  await new Promise((r) => own.listen(OWN, r));
  const ok = await new Promise((resolve) => { const s = net.connect(OWN); s.on('connect', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });
  check('a test\'s own socket still connects', ok && ownHits <= 1, `connected=${ok}`);
  own.close();

  for (const [name, env] of [['RAVENRY_SOCKET', { RAVENRY_SOCKET: LIVE_SOCK }], ['RAVENRY_HUB_URL', { RAVENRY_HUB_URL: BOARD }], ['MC_BOARD_URL', { MC_BOARD_URL: BOARD }], ['the real board\'s :4600', { RAVENRY_HUB_URL: 'http://localhost:4600' }]]) {
    m = refused(() => spawnSync('/bin/sh', ['-c', 'true'], { env: { PATH: '/usr/bin:/bin', ...env } }));
    check(`a child given ${name} is refused`, /Refused to start sh: .*the person's own/.test(m || ''), m || 'it started');
  }
  m = refused(() => spawnSync('/bin/sh', ['-c', 'true'], { env: { PATH: '/usr/bin:/bin', RAVENRY_SOCKET: OWN, RAVENRY_HUB_URL: 'http://127.0.0.1:9' } }));
  check('a child given a test\'s own socket and board starts', m === null, m);
  const real = path.join(REAL_HOME, 'Library', 'Application Support', 'Ravenry', 'run', 'ravenryd-1.0.0.sock');
  check('the person\'s real daemon socket and board read as theirs (no connection made)', personSocket(real) && personBoard('127.0.0.1', 4600) && personBoard(undefined, 4600) && !personBoard('192.168.1.50', 4600) && !personBoard('127.0.0.1', 4719) && !personSocket(OWN));
}

// ------------------------------------------------------------ every test of packages/*/test that talks to a daemon is guarded
{
  const loose = [];
  for (const pkg of fs.readdirSync(path.join(REPO, 'packages'))) {
    const dir = path.join(REPO, 'packages', pkg, 'test');
    if (!fs.existsSync(dir)) continue;
    for (const n of fs.readdirSync(dir)) {
      if (!/\.test\.(m?js|ts)$/.test(n)) continue;
      const s = fs.readFileSync(path.join(dir, n), 'utf8');
      const code = s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
      if (!/findDaemon|connectSocket|ravenryd|RAVENRYD/.test(code.join('\n'))) continue;
      const first = code.find((l) => /^import\b/.test(l)) || '';
      if (!/^import '\.\.\/\.\.\/\.\.\/(tools|hub\/tools)\/test-guard\.mjs';/.test(first)) loose.push(`packages/${pkg}/test/${n}`);
    }
  }
  check('every test under packages/*/test that talks to a daemon imports a guard first', loose.length === 0, loose.join(' '));
}

daemon.close();
board.close();
fs.rmSync(SHORT, { recursive: true, force: true });
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
