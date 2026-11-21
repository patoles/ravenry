#!/usr/bin/env node
// A remote pane comes back after a sleep or a network change (docs/FEATURES.md
// MACH-011). A made-up board of its own (its own RAVENRY_HOME under .tmp, a
// throwaway HOME) and a machine "devbox": a second ravenryd with its own
// HOME, runtime and state folders, reached through a fake `ssh` that runs
// `ravenryd proxy` here with that machine's environment (as
// tools/machines-test.mjs does). On devbox a pane runs a ticker that prints
// a numbered line every 250 ms after 300 lines of history, and echoes what
// is typed into it. Nothing real is read or touched; no window opens.
//
// The cut, two kinds, each on every ssh the hub has to devbox (its machine
// link and the terminal streams):
//   - kill: the ssh processes die (the connection closes cleanly);
//   - hang: the ssh processes stop (SIGSTOP) and never speak again, as a
//     connection left half-open by a sleeping laptop or a Wi-Fi change does.
// Meanwhile a new ssh fails ("Network is unreachable") until the network
// comes back.
//
// For each it measures and asserts, on the two paths the hub serves:
//   - the terminal stream (GET /api/term, the Mac app's live terminal):
//     the stream ends within a few seconds of the cut; while the machine
//     is away a new stream is refused 503 (the machine is away, try again),
//     never 404 (the pane is gone); once the network is back a new stream
//     opens within a few seconds, with the same pane, its history from the
//     first line, the lines printed during the cut, and typing lands;
//   - the Live screen (GET /api/live, the board on the phone and the
//     Electron app): it says the machine is away within a few seconds and
//     keeps the last screen; once back it is fresh again within a few
//     seconds, with the ticks printed during the cut;
//   - the board page itself (headless Chromium, its Live screen card): the
//     last screen stays and its chip says "Lost the connection to devbox.
//     Connecting again."; once back the chip says Live and new ticks show;
//   - the board: devbox is down then connected again, the session stays
//     one session with the same surface, and devbox has one pane.
//
//   node tools/remote-reconnect-test.mjs
//
// Pictures of the board while away: .tmp/remote-reconnect-test/*-away-*.png.
//
// RAVENRYD_BIN names the ravenryd (default ../daemon/ravenryd);
// RAVENRY_PLAYWRIGHT (a playwright index.mjs) and RAVENRY_CHROME (a Chrome
// binary) the browser, by default the hub's Playwright and its Chromium.
import { withTestHome, TEST_HOME } from './test-guard.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { freePort } from './as-phone.mjs';

const HUBDIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = path.dirname(HUBDIR);
const T = path.join(HUBDIR, 'tools');
const BIN = path.resolve(process.env.RAVENRYD_BIN || path.join(REPO, 'daemon', 'ravenryd'));
if (!fs.existsSync(BIN)) { console.error(`no ravenryd at ${BIN}; build it (daemon/README.md) or set RAVENRYD_BIN`); process.exit(1); }
const pw = process.env.RAVENRY_PLAYWRIGHT ? await import(process.env.RAVENRY_PLAYWRIGHT) : createRequire(path.join(HUBDIR, 'package.json'))('playwright');
const { frameReader } = await import('../server/termproxy.mjs');
const { connectSocket } = await import('../../packages/node-client/index.mjs');

let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); if (!ok) fails++; };
const measure = (text) => console.log(`MEASURE ${text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000, every = 100) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await Promise.resolve().then(fn).catch(() => null);
    if (v || Date.now() > end) return v;
    await sleep(every);
  }
}
const secs = (ms) => (ms == null ? 'never' : `${(ms / 1000).toFixed(1)} s`);

// ------------------------------------------------------------ the made-up board
const W = path.join(HUBDIR, '.tmp', 'remote-reconnect-test');
fs.rmSync(W, { recursive: true, force: true });
const MC = path.join(W, 'mc');
fs.mkdirSync(MC, { recursive: true });
// Unix socket paths are short: the daemons' folders in the system's temp folder.
const D = fs.mkdtempSync(path.join(os.tmpdir(), 'rvrc-'));
const R = { home: path.join(D, 'rhome'), run: path.join(D, 'rrun'), state: path.join(D, 'rstate') };
const L = { run: path.join(D, 'lrun'), state: path.join(D, 'lstate') };
for (const d of [...Object.values(R), ...Object.values(L)]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
const FAKE = path.join(D, 'fakebin');
fs.mkdirSync(FAKE);
fs.symlinkSync(BIN, path.join(FAKE, 'ravenryd'));
const DOWN = path.join(D, 'net-down');
const PIDS = path.join(D, 'ssh-pids');
const LOG = path.join(D, 'ssh-log');
const REMOTE_ENV = { HOME: R.home, PATH: `${FAKE}:/usr/bin:/bin`, SHELL: '/bin/sh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: R.run, RAVENRY_STATE_DIR: R.state };
// The fake ssh: its options dropped, the remote command run here through
// sh with devbox's environment. With the network down it fails as ssh does.
fs.writeFileSync(path.join(FAKE, 'ssh'), `#!/bin/sh
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    -T) shift ;;
    --) shift; break ;;
    -*) shift ;;
    *) host=$1; shift; [ "$1" = "--" ] && shift; break ;;
  esac
done
echo "$host $*" >> '${LOG}'
if [ -f '${DOWN}' ]; then sleep 0.2; echo "ssh: connect to host $host port 22: Network is unreachable" >&2; exit 255; fi
echo $$ >> '${PIDS}'
exec env -i ${Object.entries(REMOTE_ENV).map(([k, v]) => `${k}='${v}'`).join(' ')} SSH_CONNECTION='127.0.0.1 50022 127.0.0.1 22' SSH_CLIENT='127.0.0.1 50022 22' /bin/sh -c "$*"
`, { mode: 0o755 });
// The pane's program on devbox: it reports a session start (so the board
// lists it as a session), prints 300 lines of history, then a tick every
// 250 ms, and echoes each typed line.
const SID = 'd0d0d0d0-0000-4000-8000-00000000000d';
const PROJ = path.join(R.home, 'code', 'far-garden');
fs.mkdirSync(PROJ, { recursive: true });
fs.writeFileSync(path.join(PROJ, 'BRIEF.md'), '# far-garden\n\nGoal: Grow things far away.\n\n## Hand-off\n');
fs.writeFileSync(path.join(FAKE, 'ticker'), `#!/bin/sh
printf '{"hook_event_name":"SessionStart","session_id":"${SID}","cwd":"%s","source":"startup","model":"claude-opus-5-5"}' "$PWD" | ravenryd hook --assistant claude >/dev/null 2>&1
i=1; while [ $i -le 300 ]; do echo "history line $i"; i=$((i+1)); done
( n=1; while :; do echo "tick $n"; n=$((n+1)); sleep 0.25; done ) &
while IFS= read -r l; do echo "typed: $l"; done
`, { mode: 0o755 });

const projects = [{ id: 'far-garden', name: 'far-garden', folder: PROJ, brief: 'BRIEF.md', workspaces: [], machine: 'devbox' }];
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({
  version: 1,
  settings: { autoImport: false, ruleSources: [], contextWindow: 1000000, machines: [{ name: 'devbox', host: 'devbox' }] },
  projects,
}, null, 2));
const FAKECMUX = path.join(W, 'fake-cmux.json');
fs.writeFileSync(FAKECMUX, JSON.stringify({ workspaces: [], screens: {} }));
const PS = path.join(W, 'stub-ps.json');
fs.writeFileSync(PS, '[]');

fs.mkdirSync(TEST_HOME, { recursive: true });
const PORT = await freePort();
const hubEnv = withTestHome({
  PATH: process.env.PATH, HOME: TEST_HOME, RAVENRY_HOME: MC, PORT: String(PORT), MC_NO_EVENTS: '0', MC_REPEATS_AUTO: '0', MC_NO_AUTOSTART: '1',
  RAVENRY_TERMINAL: 'ravenry', MC_APPS: 'cmux,ravenry', RAVENRY_RUNTIME_DIR: L.run, RAVENRY_STATE_DIR: L.state,
  RAVENRY_SSH: path.join(FAKE, 'ssh'), RAVENRY_DAEMON_BIN: BIN,
  CMUX_BIN: path.join(T, 'fake-cmux.mjs'), FAKE_CMUX_STATE: FAKECMUX, MC_CLAUDE_PROJECTS: path.join(W, 'claude-projects'), MC_CODEX_HOME: path.join(W, 'codex'),
  MC_PROJECTS_ROOT: path.join(W, 'projects'), MC_GLOBAL_CLAUDE_MD: path.join(W, 'CLAUDE.md'), MC_BACKUP_DIR: path.join(W, 'backups'), MC_SCRATCH_ROOT: path.join(W, 'scratch'),
  MC_OPEN_COMMAND: JSON.stringify([process.execPath, path.join(T, 'stub-open.mjs')]), STUB_OPEN_LOG: path.join(W, 'open.jsonl'), CMUX_SURFACE_ID: '', CMUX_WORKSPACE_ID: '',
  MC_PS_BIN: path.join(T, 'stub-ps.mjs'), MC_LSOF_BIN: path.join(T, 'stub-ps.mjs'), STUB_PS_STATE: PS,
  MC_OSASCRIPT_BIN: path.join(T, 'stub-osascript.mjs'), ITERM_OSASCRIPT_BIN: path.join(T, 'stub-osascript.mjs'), STUB_OSASCRIPT_LOG: path.join(W, 'osascript.jsonl'),
  RAVENRY_HUB_BIND: '127.0.0.1', MC_CLAUDE_BIN: path.join(T, 'stub-claude.mjs'), MC_PRINT_COMMAND: JSON.stringify([process.execPath, path.join(T, 'stub-claude.mjs')]),
  MC_REPEATS_COMMAND: JSON.stringify(['/usr/bin/false']), MC_COPY_COMMAND: JSON.stringify(['/usr/bin/true']), LANG: 'en_US.UTF-8', TEST_RAVENRY: '1', MC_TEST: '1',
});

const sshPids = () => (fs.existsSync(PIDS) ? fs.readFileSync(PIDS, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const stopped = new Set();
function cleanup() {
  for (const pid of [...stopped, ...sshPids()]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  try {
    const ds = JSON.parse(execFileSync(BIN, ['daemons', '--json', '--no-start'], { env: REMOTE_ENV, encoding: 'utf8' }) || '[]');
    for (const d of ds) { try { process.kill(d.pid, 'SIGTERM'); } catch { /* gone */ } }
  } catch { /* none */ }
  try { fs.rmSync(D, { recursive: true, force: true }); } catch { /* gone */ }
}
process.on('exit', cleanup);

let hubLog = '';
const hub = spawn(process.execPath, [path.join(HUBDIR, 'server', 'index.mjs')], { cwd: TEST_HOME, env: hubEnv, stdio: ['ignore', 'pipe', 'pipe'] });
hub.stdout.on('data', (d) => { hubLog += d; });
hub.stderr.on('data', (d) => { hubLog += d; });
process.on('exit', () => { try { hub.kill('SIGTERM'); } catch { /* gone */ } });
const base = `http://127.0.0.1:${PORT}`;
const getJson = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => null) }; };
const state = async () => (await getJson('/api/state')).body;
const devbox = (st) => (st && st.machines || []).find((m) => m.name === 'devbox') || null;
const sessionsOf = (st) => { const out = []; for (const p of (st && st.projects) || []) for (const s of p.sessions || []) if (s.sessionId === SID) out.push({ p: p.id, surfaceId: s.surfaceId, terminal: s.terminal }); return out; };

// ------------------------------------------------------------ the terminal stream, as the Mac app opens it
// GET /api/term?pane=, then hello and pane.subscribe; `lines()` is what the
// pane printed since, `ended` the time the stream ended.
function termOpen(pane) {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    const o = { status: 0, head: '', texts: [], out: '', ended: null, s, channel: null };
    let buf = Buffer.alloc(0);
    let upgraded = false;
    const read = frameReader((f) => {
      if (f.op === 1) { try { o.texts.push(JSON.parse(f.payload.toString('utf8'))); } catch { /* not JSON */ } } else if (f.op === 2) {
        // A binary frame: version, kind, channel (4), mark (8), then the bytes.
        if (f.payload.length > 14) o.out += f.payload.subarray(14).toString('utf8');
      } else if (f.op === 8 && o.ended == null) o.ended = Date.now();
      return true;
    });
    o.send = (obj) => {
      const pl = Buffer.from(JSON.stringify(obj));
      const mask = crypto.randomBytes(4);
      const hdr = pl.length < 126 ? Buffer.from([0x81, 0x80 | pl.length]) : Buffer.from([0x81, 0x80 | 126, pl.length >> 8, pl.length & 255]);
      const m = Buffer.from(pl);
      for (let i = 0; i < m.length; i++) m[i] ^= mask[i & 3];
      if (!s.destroyed) s.write(Buffer.concat([hdr, mask, m]));
    };
    o.request = async (type, params = {}, ms = 5000) => {
      const id = Math.floor(Math.random() * 1e9);
      o.send({ v: 1, type, id, ...params });
      return until(() => o.texts.find((t) => t.id === id && (t.type === 'result' || t.type === 'error')), ms, 20);
    };
    o.close = () => { try { s.destroy(); } catch { /* gone */ } };
    s.on('connect', () => s.write(`GET /api/term?pane=${pane} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Protocol: ravenry.v1\r\n\r\n`));
    s.on('data', (d) => {
      if (upgraded) return read(d);
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      o.head = buf.subarray(0, i).toString('latin1');
      o.status = Number(o.head.split(' ')[1]);
      upgraded = o.status === 101;
      const rest = buf.subarray(i + 4);
      resolve(o);
      if (upgraded && rest.length) read(rest);
    });
    s.on('error', () => {});
    s.on('close', () => { if (o.ended == null) o.ended = Date.now(); if (!o.head) resolve(o); });
  });
}

// A stream that says hello and subscribes: { o, ok, why }.
async function termLive(pane) {
  const o = await termOpen(pane);
  if (o.status !== 101) return { o, ok: false, why: o.head.split('\r\n')[0] || 'closed before an answer' };
  const h = await o.request('hello', { client: { name: 'remote-reconnect-test', version: '0' } });
  if (!h || h.type !== 'result') return { o, ok: false, why: `hello: ${JSON.stringify(h)}` };
  const sub = await o.request('pane.subscribe', { pane });
  if (!sub || sub.type !== 'result') return { o, ok: false, why: `subscribe: ${JSON.stringify(sub)}` };
  o.channel = sub.result && sub.result.channel;
  return { o, ok: true };
}

// The pane's screen and history through a stream: its text.
async function capture(o, pane) {
  const r = await o.request('pane.capture', { pane, history: 2000 });
  if (!r || r.type !== 'result') return null;
  return ((r.result && r.result.lines) || []).map((l) => l.text || '').join('\n');
}
const lastTick = (text) => { let n = 0; for (const m of String(text || '').matchAll(/tick (\d+)/g)) n = Math.max(n, Number(m[1])); return n; };

// ------------------------------------------------------------ up
let browser = null;
let page = null;
const boardLook = () => page.evaluate(() => ({ chip: ((document.querySelector('#lv-card [data-fresh] span') || {}).textContent || '').trim(), ticks: ((document.querySelector('#lv-lines') || {}).innerText || '').match(/tick \d+/g)?.length || 0, last: Math.max(0, ...(((document.querySelector('#lv-lines') || {}).innerText || '').match(/tick (\d+)/g) || []).map((x) => Number(x.slice(5)))) }));
let PANE = null;
let SURFACE = null;
try {
  const up = await until(async () => devbox(await state())?.state === 'connected', 30000, 250);
  check('board_up_devbox_connected', !!up, up ? '' : hubLog.slice(-1500));
  if (!up) throw new Error('the board did not come up');
  // The pane on devbox, as a session started there would have it.
  const version = /ravenryd (\S+)/.exec(execFileSync(BIN, ['version'], { env: REMOTE_ENV, encoding: 'utf8' }))[1];
  const RSOCK = path.join(R.run, `ravenryd-${version}.sock`);
  const rc = await connectSocket(RSOCK, { name: 'remote-reconnect-test' });
  const { pane } = await rc.request('pane.new', { cwd: PROJ, name: 'far-garden', command: [path.join(FAKE, 'ticker')], cols: 100, rows: 30, labels: { 'ravenry.session': 'claude' } });
  rc.close();
  PANE = pane.id;
  SURFACE = `ravenry:${PANE}`;
  const listed = await until(async () => { const st = await state(); const s = sessionsOf(st); return s.length === 1 && s[0].surfaceId === SURFACE ? st : null; }, 20000, 250);
  check('the_session_on_devbox_is_on_the_board', !!listed, JSON.stringify(sessionsOf(await state())));
  const first = await termLive(PANE);
  check('terminal_stream_opens', first.ok, first.why || '');
  const cap0 = first.ok ? await until(async () => { const c = await capture(first.o, PANE); return c && /history line 1\b/.test(c) && lastTick(c) > 2 ? c : null; }, 15000, 200) : null;
  check('terminal_stream_reads_history_and_ticks', !!cap0, cap0 ? `tick ${lastTick(cap0)}` : '');
  const lv0 = await until(async () => { const r = await getJson(`/api/live?surface=${encodeURIComponent(SURFACE)}`); return r.status === 200 && r.body.at && JSON.stringify(r.body.entries || []).includes('tick') ? r : null; }, 15000, 300);
  check('live_screen_reads_it', !!lv0, lv0 ? '' : JSON.stringify((await getJson(`/api/live?surface=${encodeURIComponent(SURFACE)}`)).body).slice(0, 300));
  first.o.close();
  // The board page, as a phone or a browser shows it: the session's Live screen card.
  fs.mkdirSync(path.join(W, 'browser-home'), { recursive: true });
  browser = await pw.chromium.launch({ headless: true, env: { PATH: '/usr/bin:/bin', HOME: path.join(W, 'browser-home'), TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8', RAVENRY_DESKTOP_DATA: path.join(W, 'browser-home', 'app-data') }, ...(process.env.RAVENRY_CHROME ? { executablePath: process.env.RAVENRY_CHROME } : {}) });
  page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.on('pageerror', (e) => check('no_page_error', false, e.message));
  await page.goto(`${base}/?p=far-garden`);
  const shown = await until(() => page.evaluate(() => /tick \d+/.test((document.querySelector('#lv-lines') || {}).innerText || '')), 20000, 200);
  check('the_board_shows_its_live_screen', !!shown);

  // ------------------------------------------------------------ the cuts
  for (const kind of ['kill', 'hang']) {
    console.log(`---- ${kind}`);
    // The view open before the cut: a stream and the Live screen polled as the board does (every second).
    const v = await termLive(PANE);
    check(`${kind}: a stream is open before the cut`, v.ok, v.why || '');
    const capBefore = await capture(v.o, PANE);
    const tickBefore = lastTick(capBefore);
    const live = [];
    let polling = true;
    const poll = (async () => {
      while (polling) {
        const t = Date.now();
        const r = await Promise.race([getJson(`/api/live?surface=${encodeURIComponent(SURFACE)}`).catch((e) => ({ status: 0, body: { error: e.message } })), sleep(4000).then(() => ({ status: -1, body: { error: 'no answer in 4 s' } }))]);
        const st = await Promise.race([state().catch(() => null), sleep(4000).then(() => null)]);
        const look = await boardLook().catch(() => ({}));
        live.push({ look, sess: sessionsOf(st)[0] || null, t, status: r.status, at: r.body && r.body.at, ticks: lastTick(JSON.stringify(r.body && r.body.entries || [])), error: r.body && r.body.error, machine: devbox(st)?.state, sessions: sessionsOf(st).length, away: r.body && r.body.away });
        await sleep(1000);
      }
    })();
    await sleep(1500);
    const pids = sshPids().filter(alive);
    fs.writeFileSync(DOWN, '');
    const cut = Date.now();
    for (const pid of pids) { try { process.kill(pid, kind === 'kill' ? 'SIGKILL' : 'SIGSTOP'); if (kind === 'hang') stopped.add(pid); } catch { /* gone */ } }
    measure(`${kind}: cut ${pids.length} ssh processes`);
    // The stream ends.
    await until(() => v.o.ended != null, 70000, 50);
    const termNotice = v.o.ended != null ? v.o.ended - cut : null;
    // While away, a new stream: refused as away (503), never as gone (404).
    const away = await termOpen(PANE);
    const awayStatus = away.status;
    away.close();
    // The board notices.
    await until(() => live.some((x) => x.t > cut && x.machine && x.machine !== 'connected'), 70000, 100);
    const boardNotice = live.find((x) => x.t > cut && x.machine && x.machine !== 'connected');
    // Pictures of the board while away: wide, and at a phone's width.
    if (boardNotice) {
      await sleep(1500);
      await page.screenshot({ path: path.join(W, `${kind}-away-wide.png`) });
      const narrow = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
      await narrow.goto(`${base}/?p=far-garden`);
      await until(() => narrow.evaluate(() => /tick \d+/.test((document.querySelector('#lv-lines') || {}).innerText || '')), 10000, 200);
      await sleep(1200);
      await narrow.screenshot({ path: path.join(W, `${kind}-away-phone.png`) });
      await narrow.context().close();
    }
    // The network stays down 12 s after the cut (or until noticed, for a slow notice), then comes back.
    await sleep(Math.max(0, cut + 12000 - Date.now()));
    const during = live.filter((x) => x.t > cut);
    fs.rmSync(DOWN, { force: true });
    const back = Date.now();
    // A client that tries again every second, as the Mac app now does.
    let again = null;
    let tries = 0;
    const end = Date.now() + 60000;
    while (Date.now() < end) {
      tries++;
      const a = await termLive(PANE);
      if (a.ok) { again = a; break; }
      a.o.close();
      await sleep(1000);
    }
    const termBack = again ? Date.now() - back : null;
    const capAfter = again ? await capture(again.o, PANE) : null;
    // Typing lands.
    let typed = false;
    if (again) {
      const word = `hello-${kind}-${Date.now() % 10000}`;
      const sent = await again.o.request('pane.send', { pane: PANE, input: [{ text: word, mode: 'paste' }, { key: 'Enter' }], by: 'phone' });
      if (!sent || sent.type !== 'result') console.log('pane.send:', JSON.stringify(sent));
      typed = !!(await until(async () => (await capture(again.o, PANE) || '').includes(`typed: ${word}`), 5000, 100));
    }
    // The Live screen is fresh again, with ticks past the cut.
    const liveFresh = await until(() => live.find((x) => x.t > back && x.status === 200 && x.at && x.at > back && x.ticks > tickBefore), 60000, 100);
    polling = false;
    await poll;
    const st = await state();
    const panes = (await until(async () => { const c = await connectSocket(path.join(R.run, fs.readdirSync(R.run).find((n) => /^ravenryd-.+\.sock$/.test(n))), { name: 'remote-reconnect-test' }); const l = await c.request('pane.list', { hidden: true }); c.close(); return l.panes; }, 5000)) || [];

    measure(`${kind}: the terminal stream ended ${secs(termNotice)} after the cut`);
    measure(`${kind}: the board said devbox ${boardNotice ? boardNotice.machine : '(nothing)'} ${secs(boardNotice ? boardNotice.t - cut : null)} after the cut`);
    measure(`${kind}: a new stream while away: ${awayStatus || 'closed without an answer'}`);
    measure(`${kind}: the Live screen while away: ${[...new Set(during.map((x) => `${x.status}${x.error ? ` "${x.error}"` : ''}${x.away ? ' away' : ''}`))].join(', ')}`);
    measure(`${kind}: the board's sessions for it while away: ${[...new Set(during.map((x) => x.sessions))].join(', ')}`);
    measure(`${kind}: a stream again ${secs(termBack)} after the network came back (${tries} tries)`);
    measure(`${kind}: the Live screen fresh ${secs(liveFresh ? liveFresh.t - back : null)} after the network came back`);
    check(`${kind}: the stream ends within 15 s of the cut`, termNotice != null && termNotice < 15000, secs(termNotice));
    check(`${kind}: the board says devbox is not connected within 15 s`, !!boardNotice && boardNotice.t - cut < 15000, boardNotice ? secs(boardNotice.t - cut) : 'never');
    check(`${kind}: a new stream while away is refused as away (503), not as gone`, awayStatus === 503, String(awayStatus));
    check(`${kind}: the Live screen while away keeps the last screen and says the machine is away`, during.length > 0 && during.every((x) => x.status === 200 || x.status === -1) && during.some((x) => x.away), JSON.stringify(during.slice(0, 4)));
    check(`${kind}: the session stays on the board, once, with its surface and its screen, while away`, during.every((x) => x.sessions === 1 && x.sess.surfaceId === SURFACE && x.sess.terminal !== false), JSON.stringify(during.map((x) => x.sess).slice(-3)));
    check(`${kind}: a stream opens again within 5 s of the network coming back`, termBack != null && termBack < 5000, secs(termBack));
    check(`${kind}: the history is all there (its first line)`, !!capAfter && /history line 1\b/.test(capAfter));
    check(`${kind}: the pane kept running during the cut (ticks past the cut)`, lastTick(capAfter) > tickBefore + 40, `tick ${tickBefore} before, ${lastTick(capAfter)} after`);
    check(`${kind}: typing lands again`, typed);
    check(`${kind}: the Live screen is fresh again within 5 s, with the ticks of the cut`, !!liveFresh && liveFresh.t - back < 5000, liveFresh ? secs(liveFresh.t - back) : 'never');
    const looks = during.filter((x) => x.machine && x.machine !== 'connected').map((x) => x.look);
    measure(`${kind}: the board's chip while away: ${[...new Set(looks.map((x) => `"${x.chip}"`))].join(', ')}`);
    check(`${kind}: the board keeps the last screen and its chip says it lost devbox`, looks.length > 0 && looks.every((x) => x.ticks > 0 && x.chip === 'Lost the connection to devbox. Connecting again.'), JSON.stringify(looks.slice(0, 3)));
    const lookBack = await until(async () => { const x = await boardLook(); return /^Live\b/.test(x.chip) && x.last > tickBefore + 40 ? x : null; }, 10000, 200);
    check(`${kind}: the board is Live again with the ticks of the cut`, !!lookBack, JSON.stringify(lookBack || await boardLook()));
    check(`${kind}: one session, the same surface; devbox has one pane`, sessionsOf(st).length === 1 && sessionsOf(st)[0].surfaceId === SURFACE && panes.length === 1 && panes[0].id === PANE, JSON.stringify({ s: sessionsOf(st), panes: panes.map((x) => x.id) }));
    v.o.close();
    if (again) again.o.close();
    for (const pid of stopped) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    stopped.clear();
  }
} catch (e) {
  check('ran', false, e.stack);
} finally {
  if (fails) console.log(hubLog.split('\n').filter((l) => /term|machine|devbox|ssh/i.test(l)).slice(-30).join('\n'));
  if (browser) await browser.close().catch(() => {});
  try { hub.kill('SIGTERM'); } catch { /* gone */ }
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
}
