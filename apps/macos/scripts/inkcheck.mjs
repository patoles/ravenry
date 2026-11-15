#!/usr/bin/env node
// The check of Ink, the launch's animation, and the pane effects
// (Ink.swift, Shaders.swift, SelfTestInk.swift), never on screen and never
// on the person's hub, daemon or settings: throwaway daemons (HOME, runtime
// and state folders in the repository's .tmp), the demo hub of the
// desktop's screenshots on 127.0.0.1, and the app off every screen with
// RAVENRY_MAC_INK=1 (off every screen Ink plays for this check only). Four
// launches:
//
// 1. launch: a daemon with no shell. New session opens and Ink plays over
//    it to the end, then again with a press and a key half way, the mark on
//    the real icon, Settings' switches pressed, the pane effects' pixels.
// 2. restored: the same daemon, its shell now a tab to bring back: no Ink,
//    and the window on the hub's openOn (NAV-009), the session used last.
// 3. off: a new daemon, the setting off in the settings file: no Ink.
// 4. reduced: a new daemon, Reduce motion on (RAVENRY_MAC_REDUCE_MOTION=1): no Ink.
//
// It prints a line a check and leaves in OUT the pictures (Ink at 0.5, 1.4,
// 2.2, 2.9 s and its end at 1280 and 900 points, a pane with each effect,
// Settings) and ink.gif from the offscreen frames (with ffmpeg, when found).
//
//   node scripts/inkcheck.mjs [OUT]     (after scripts/build.sh; INKCHECK_APP=PATH for another build)
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDemoHub, freePort } from '../../desktop/tools/demo-hub.mjs';
import { testApp } from './testapp.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAC = path.resolve(HERE, '..');
const REPO = path.resolve(MAC, '..', '..');
// A development build or a package's test twin, never the release (testapp.mjs, Gate.swift).
const { app: APP, exe: EXE } = testApp(process.env.INKCHECK_APP || path.join(MAC, 'build', 'RavenryMac.app'));
const BIN = path.join(APP, 'Contents', 'MacOS', 'ravenryd');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(path.join(REPO, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(REPO, '.tmp', 'macos-ink.'));
const OUT = path.resolve(process.argv[2] || path.join(tmp, 'out'));
fs.mkdirSync(OUT, { recursive: true });

// The demo hub listens on 127.0.0.1 only (not every address, as it does by itself).
const bindLocal = path.join(tmp, 'bind-local.mjs');
fs.writeFileSync(bindLocal, `import net from 'node:net';
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...a) {
  if (typeof a[0] === 'number' && (a.length === 1 || typeof a[1] === 'function')) a.splice(1, 0, '127.0.0.1');
  return listen.apply(this, a);
};
`);
const hub = await startDemoHub({ dir: path.join(tmp, 'hub'), port: await freePort(), env: { NODE_OPTIONS: `--import ${bindLocal}` } });

const daemons = [];
async function place(name) {
  const dir = path.join(tmp, name);
  const user = path.join(dir, 'user'), run = path.join(dir, 'run'), state = path.join(dir, 'state'), data = path.join(dir, 'desktop');
  for (const d of [user, run, state, data]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(user, '.zshrc'), "PROMPT='~ > '\n");
  fs.writeFileSync(path.join(user, '.zshenv'), 'skip_global_compinit=1\n');
  const env = { HOME: user, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: run, RAVENRY_STATE_DIR: state, RAVENRY_DESKTOP_DATA: data };
  const d = spawn(BIN, ['serve'], { env, stdio: ['ignore', 'ignore', fs.openSync(path.join(dir, 'daemon.log'), 'w')] });
  daemons.push(d);
  const v = JSON.parse(execFileSync(BIN, ['version', '--json'], { env, encoding: 'utf8' })).version;
  const sock = path.join(run, `ravenryd-${v.replace(/[^A-Za-z0-9._-]/g, '_')}.sock`);
  for (let i = 0; !fs.existsSync(sock); i++) { if (i > 100) throw new Error('the daemon did not start'); await sleep(50); }
  return { env, sock, data, dir };
}

let failed = 0;
async function launch(p, kase, extra = {}) {
  const out = path.join(OUT, `${kase}.json`);
  fs.rmSync(out, { force: true });
  const app = spawn(EXE, ['--offscreen', '--socket', p.sock, '--sidetest', out, '--screen', 'ink'], {
    env: { ...p.env, RAVENRY_HUB_URL: hub.url, RAVENRY_MAC_INK: '1', RAVENRY_MAC_INK_CASE: kase, RAVENRY_MAC_EVENTS_LOG: path.join(p.dir, 'events.log'), ...extra },
    stdio: ['ignore', 'ignore', fs.openSync(path.join(p.dir, `app-${kase}.log`), 'w')],
  });
  const exited = new Promise((r) => app.on('exit', r));
  const t0 = Date.now();
  if (await Promise.race([exited.then(() => true), sleep(180000).then(() => false)]) === false) { app.kill(); console.log(`FAIL ${kase}: the app did not finish in 3 minutes`); failed++; return; }
  let res;
  try { res = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { console.log(`FAIL ${kase}: no result (${path.join(p.dir, `app-${kase}.log`)})`); failed++; return; }
  for (const c of res.checks) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? 'pass' : 'FAIL'} ${kase} ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
  }
  console.log(`(${kase}: ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

try {
  const a = await place('a');
  await launch(a, 'launch');
  // The launch made a shell, and the window kept it: brought back now.
  await launch(a, 'restored');
  const b = await place('b');
  fs.writeFileSync(path.join(b.data, 'settings.json'), JSON.stringify({ version: 1, launchInk: false }, null, 2));
  await launch(b, 'off');
  const c = await place('c');
  await launch(c, 'reduced', { RAVENRY_MAC_REDUCE_MOTION: '1' });
} finally {
  hub.stop();
  for (const d of daemons) d.kill();
}

// The offscreen frames as a GIF (20 a second, at half size).
const frames = path.join(OUT, 'ink-gif');
if (fs.existsSync(path.join(frames, 'f000.png'))) {
  try {
    const gif = path.join(OUT, 'ink.gif');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '20', '-i', path.join(frames, 'f%03d.png'), '-vf', 'split[a][b];[a]palettegen=max_colors=192[p];[b][p]paletteuse=dither=sierra2_4a', gif]);
    console.log(`gif: ${gif} (${Math.round(fs.statSync(gif).size / 1024)} KB)`);
  } catch (e) { console.log(`gif: not made (${String(e.message).split('\n')[0]})`); }
}
console.log(`pictures: ${OUT}`);
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
