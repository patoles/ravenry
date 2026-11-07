#!/usr/bin/env node
// The window while the hub waits for macOS to say whether it may read
// ~/Documents (hub/server/access.mjs), never on screen: a hub on a
// throwaway HOME whose read of ~/Documents is a FIFO (it waits until this
// script opens it), and the app on it. Shot dark and light, then the read
// returns and the board comes.
//
//   node build.mjs && node tools/access-shots.mjs <outDir>
//
// Writes access-waiting-dark.png and -light.png (1440x900). Needs ravenryd:
// RAVENRYD, else ../../daemon/ravenryd.
import { guardSpawns, withStubMachine } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { APP, runApp, stopDaemons } from './run-app.mjs';

guardSpawns();

const OUT = path.resolve(process.argv[2] || path.join(APP, '.tmp', 'access-shots'));
const WORK = path.join(OUT, '.work-access');
const BIN = process.env.RAVENRYD || path.resolve(APP, '..', '..', 'daemon', 'ravenryd');
if (!fs.existsSync(BIN)) { console.error(`no ravenryd at ${BIN}; build it (daemon/README.md) or set RAVENRYD`); process.exit(1); }
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const RT = fs.mkdtempSync(path.join(process.env.RAVENRY_SHORT_TMP || os.tmpdir(), 'rva-'));
fs.chmodSync(RT, 0o700);
const HUB = path.resolve(APP, '..', '..', 'hub');
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

const HOME = path.join(WORK, 'home');
const MC = path.join(HOME, '.ravenry');
const DOCS = path.join(HOME, 'Documents');
fs.mkdirSync(MC, { recursive: true });
fs.mkdirSync(path.join(DOCS, 'garden-planner'), { recursive: true });
fs.writeFileSync(path.join(MC, 'projects.json'), JSON.stringify({ version: 1, settings: { autoImport: false, repeatsAuto: false }, projects: [{ id: 'garden-planner', name: 'garden-planner', folder: path.join(DOCS, 'garden-planner'), workspaces: [], brief: 'BRIEF.md' }] }));
const FIFO = path.join(WORK, 'documents-read');
execFileSync('mkfifo', [FIFO]);
const port = await freePort();
const hub = spawn(process.execPath, [path.join(HUB, 'server', 'index.mjs')], {
  env: withStubMachine({ PATH: process.env.PATH, HOME, RAVENRY_HOME: MC, PORT: String(port), RAVENRY_TERMINAL: 'ravenry', MC_APPS: 'ravenry', MC_ACCESS_PROBE: JSON.stringify({ [DOCS]: FIFO }), MC_NO_AUTOSTART: '1', MC_REPEATS_AUTO: '0', MC_CODEX: '0', MC_PHONE_LAN: 'none', MC_CLAUDE_PROJECTS: path.join(HOME, '.claude', 'projects') }),
  stdio: 'ignore',
});
const sig = path.join(WORK, 'shot.signal');
const go = path.join(WORK, 'shot.go');
const shot = (name) => [
  { theme: 'dark' }, { js: 'void 0' }, { shot: path.join(OUT, `${name}-dark.png`), settle: 500 },
  { theme: 'light' }, { shot: path.join(OUT, `${name}-light.png`), settle: 500 },
  { theme: 'dark' },
];
try {
  const app = runApp({
    name: 'access', work: WORK, rt: RT, bin: BIN, home: HOME, hubUrl: `http://127.0.0.1:${port}`,
    env: { RAVENRY_SERVICE: 'off' },
    steps: [
      { ready: true },
      { until: `document.querySelector('#side .access-note') && document.querySelector('#side .access-note').textContent.includes('Click Allow')`, timeout: 20000 },
      ...shot('access-waiting'),
      { signal: sig }, { wait: go, timeout: 60000 },
      { until: `!document.querySelector('#side .access-note') && window.__ravenry.S.hub && window.__ravenry.S.hub.projects && window.__ravenry.S.hub.projects.length === 1`, timeout: 20000 },
    ],
  });
  const feed = (async () => {
    while (!fs.existsSync(sig)) await new Promise((r) => setTimeout(r, 100));
    fs.closeSync(fs.openSync(FIFO, 'w'));
    fs.writeFileSync(go, '1');
  })();
  await Promise.all([app, feed]);
  console.log('wrote access-waiting-dark.png, access-waiting-light.png; the board came once the read returned');
} finally {
  hub.kill('SIGTERM');
  stopDaemons(BIN, RT);
  fs.rmSync(RT, { recursive: true, force: true });
}
