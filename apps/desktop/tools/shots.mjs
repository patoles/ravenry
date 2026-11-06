#!/usr/bin/env node
// Screenshots of the app and its keystroke echo, never on screen: the
// window renders offscreen and is captured. Each run gets its own HOME,
// app data, daemon runtime folder and demo board, all under OUT/.work.
//
//   node build.mjs && node tools/shots.mjs <outDir>
//
// Needs a ravenryd binary: RAVENRYD, else ../../daemon/ravenryd.
// Writes to <outDir>:
//   wide-shell.png       1440x900: the board, a real shell (zsh -f), and the
//                        panel opened by a question that arrived
//   wide-session.png     1440x900: a session picked in the sidebar
//   narrow-folded.png    900x700: the panel folded away
//   narrow-arrival.png   900x700: a question arrived, the panel over the terminal
//   first-launch.png     1440x900: no session anywhere yet
//   echo.json            keystroke echo, median and p95
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startDemoHub } from './demo-hub.mjs';
import { APP, runApp, stopDaemons } from './run-app.mjs';

const OUT = path.resolve(process.argv[2] || path.join(APP, '.tmp', 'shots'));
const WORK = path.join(OUT, '.work');
const BIN = process.env.RAVENRYD || path.resolve(APP, '..', '..', 'daemon', 'ravenryd');
if (!fs.existsSync(BIN)) { console.error(`no ravenryd at ${BIN}; build it (daemon/README.md) or set RAVENRYD`); process.exit(1); }
fs.mkdirSync(WORK, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A short private runtime folder: a unix socket path has a length limit.
const RT = fs.mkdtempSync(path.join(process.env.RAVENRY_SHORT_TMP || os.tmpdir(), 'rvs-'));
fs.chmodSync(RT, 0o700);

function freePort() {
  return new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}

// A proxy in front of the demo board that marks one project as running on
// another machine, so the machine tag (a seam until remote sessions land)
// can be seen. Everything else passes through unchanged.
function machineProxy(target, port, remote = { 'recipe-box': 'devbox', 'weather-widget': 'gpu-box' }) {
  const mark = (s) => {
    for (const p of s.projects || []) if (remote[p.id]) { p.machine = remote[p.id]; for (const x of p.sessions || []) x.machine = remote[p.id]; }
    return s;
  };
  const srv = http.createServer((req, res) => {
    const up = http.request(target + req.url, { method: req.method, headers: { ...req.headers, host: new URL(target).host } }, (r) => {
      if (req.url === '/api/events') {
        res.writeHead(r.statusCode, r.headers);
        let buf = '';
        r.setEncoding('utf8');
        r.on('data', (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const out = block.split('\n').map((l) => (l.startsWith('data: ') ? 'data: ' + JSON.stringify(mark(JSON.parse(l.slice(6)))) : l)).join('\n');
            res.write(out + '\n\n');
          }
        });
        r.on('end', () => res.end());
        return;
      }
      if (req.url === '/api/state') {
        let b = ''; r.setEncoding('utf8'); r.on('data', (d) => { b += d; });
        r.on('end', () => { res.writeHead(r.statusCode, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(mark(JSON.parse(b)))); });
        return;
      }
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

const run = (name, o) => runApp({ name, work: WORK, rt: RT, bin: BIN, ...o });
const stopAll = () => stopDaemons(BIN, RT);

const shot = (f, extra = {}) => ({ shot: path.join(OUT, f), ...extra });
const sig = (n) => path.join(WORK, `${n}.signal`);
const go = (n) => path.join(WORK, `${n}.go`);
for (const f of fs.readdirSync(WORK)) if (/\.(signal|go)$/.test(f)) fs.rmSync(path.join(WORK, f));

const ONLY = process.argv[3] || '';
let hub, proxy;
try {
  if (!ONLY || ONLY === 'board') {
  // ------------------------------------------------ the board, wide and narrow
  const hubPort = await freePort();
  hub = await startDemoHub({ dir: path.join(WORK, 'demo'), port: hubPort });
  const proxyPort = await freePort();
  proxy = await machineProxy(hub.url, proxyPort);
  const hubUrl = `http://127.0.0.1:${proxyPort}`;
  const home = hub.home;
  const S = 'window.__ravenry.S';
  const app = run('board', {
    home, hubUrl,
    steps: [
      { ready: true },
      { until: `${S}.hub && ${S}.hub.projects && ${S}.hub.projects.length === 5` },
      { js: 'window.__ravenry.newShell()' },
      { until: `window.__ravenry.term().attached && window.__ravenry.term().term.buffer.active.cursorX > 0` },
      { type: 'cd ~/Projects/garden-planner\r', after: 300 },
      { type: 'ls\r', after: 300 },
      { type: 'git log --oneline --decorate\r', after: 300 },
      { type: 'echo "a terminal that answers $((6*7)) times faster"\r', after: 500 },
      // A question arrives on the board: the panel opens on it.
      { signal: sig('arrive1') }, { wait: go('arrive1') },
      { until: `${S}.panelKey === 'paper-boat/sf-3'`, timeout: 20000 },
      shot('wide-shell.png'),
      // Keystroke echo, with the shell running cat.
      { type: 'clear; cat\r', after: 600 },
      { echo: { n: 240, out: path.join(OUT, 'echo.json') } },
      { key: 'c', modifiers: ['control'], after: 200 },
      { js: 'window.__ravenry.onCommand("next-tab", 1)' },
      // A session picked in the sidebar.
      { js: `[...document.querySelectorAll('.ss')].find((e) => e.textContent.includes('Planting')).click()` },
      { until: `!document.getElementById('elsewhere').hidden`, timeout: 5000 },
      shot('wide-session.png'),
      // Narrow: the panel folds away by itself.
      { js: `window.__ravenry.setView({ kind: 'tab', id: ${S}.tabs[0].id }); ${S}.overlay = false; ${S}.panelKey = null;` },
      { size: [900, 700] },
      { js: 'window.dispatchEvent(new Event("resize"))' },
      { until: `document.getElementById('panel').hidden` },
      { type: 'clear; ls ~/Projects\r', after: 500 },
      shot('narrow-folded.png'),
      { signal: sig('arrive2') }, { wait: go('arrive2') },
      { until: `${S}.panelKey === 'notes-app/sf-4' && !document.getElementById('panel').hidden`, timeout: 20000 },
      shot('narrow-arrival.png'),
      { save: { expr: `({ tabs: ${S}.tabs.length, renderer: window.__ravenry.term().renderer, cols: window.__ravenry.term().term.cols, rows: window.__ravenry.term().term.rows })`, out: path.join(WORK, 'board-state.json') } },
    ],
  });
  // The board's side of the arrivals.
  const feed = (async () => {
    for (const [n, id, q] of [['arrive1', 'paper-boat', 'Tilt the hull with the slope too, or keep it level?'], ['arrive2', 'notes-app', 'The settings screen is done. Ship the beta to the testers?']]) {
      while (!fs.existsSync(sig(n))) await sleep(50);
      await hub.arrive(id, q);
      fs.writeFileSync(go(n), '1');
    }
  })();
  await Promise.race([app, feed.then(() => app)]);
  stopAll();
  hub.stop(); hub = null;
  proxy.close(); proxy = null;
  }

  // ------------------------------------------------ first launch
  const emptyPort = await freePort();
  hub = await startDemoHub({ dir: path.join(WORK, 'demo-empty'), port: emptyPort, empty: true });
  // Folders to pick from, and both assistants installed and signed in, as
  // on a new user's machine (stand-ins in the throwaway HOME: never run).
  for (const n of ['weather-api', 'landing-page', 'notes-cli']) {
    const d = path.join(hub.root, n);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'README.md'), `# ${n}\n`);
    const t = new Date(Date.now() - ['weather-api', 'landing-page', 'notes-cli'].indexOf(n) * 3600e3);
    fs.utimesSync(d, t, t);
  }
  const bin = path.join(hub.home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const b of ['claude', 'codex']) fs.writeFileSync(path.join(bin, b), '#!/bin/sh\necho "a stand-in for $0"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(hub.home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'you@example.com' } }));
  fs.mkdirSync(path.join(hub.home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(hub.home, '.codex', 'auth.json'), '{}');
  await run('first', {
    home: hub.home, hubUrl: hub.url,
    steps: [
      { ready: true },
      { until: `!document.getElementById('start').hidden && document.querySelectorAll('.fo').length > 0` },
      shot('first-launch.png'),
    ],
  });
  if (ONLY) process.exit(0);
  console.log('wrote', fs.readdirSync(OUT).filter((f) => !f.startsWith('.')).join(', '));
  console.log('echo', fs.readFileSync(path.join(OUT, 'echo.json'), 'utf8'));
  console.log('state', fs.readFileSync(path.join(WORK, 'board-state.json'), 'utf8'));
} finally {
  stopAll();
  hub?.stop();
  proxy?.close();
  fs.rmSync(RT, { recursive: true, force: true });
}
