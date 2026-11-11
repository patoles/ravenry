#!/usr/bin/env node
// The bench of the whole window's drag (Bench.swift runResize), never on
// screen and never on the person's hub or daemon: a throwaway ravenryd
// (HOME, runtime and state folders in the repository's .tmp), the demo hub
// of the desktop's screenshots (apps/desktop/tools/demo-hub.mjs), then the
// app with its window off every screen on both, drawing through its Metal
// layer as on screen, the sidebar and the panel shown, four tabs, the one
// in front busy. Prints a summary; bench.json and the app's log in OUT.
//
//   node scripts/resizebench.mjs [OUT]      (after scripts/build.sh)
//   node scripts/resizebench.mjs --daemons OLD_RAVENRYD [--front old|new] [OUT]
//   node scripts/resizebench.mjs --onscreen [OUT]
//   node scripts/resizebench.mjs --content busy|idle|COMMAND [OUT]
//
// --content: what the tab in front shows during the drag: busy (the
// default, a loop printing about 30 lines a second that redraws its
// screen as Claude Code does, once for every size it is told, in order,
// 150 ms after it, each word at its column), idle (the shell at its
// prompt), or a command typed in it, as a replay of a real Claude tab
// with its history and a spinner line (Simon's feel checks: real content
// beside an empty shell). The content check counts the frames of the drag
// short of a tenth or more of the rows of text the screen had before it
// (a redraw shown half done), and the frames of the drag and the 600 ms
// after it with bars (four rows or more ending in a lone character: a
// redraw laid out for a wider width on a narrower screen), and fails the
// run when there is one.
//
// --daemons: the window on two daemons, as after an update: OLD_RAVENRYD (a
// release's, 0.1.23 or later) and this tree's ravenryd built as the desktop
// app's version, two shells each, and the app with no --socket; the busy tab
// in front is the older daemon's shell (--front old, the default) or the
// newer's (--front new).
//
// BENCH_APP: another build of the app (default apps/macos/build/RavenryMac.app).
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testApp } from './testapp.mjs';
import { startDemoHub } from '../../desktop/tools/demo-hub.mjs';

guardSpawns();
const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv.splice(i, 2)[1] : null; };
const OLD = flag('--daemons');
const FRONT = flag('--front') || 'old';
const CONTENT = flag('--content') || 'busy';
// --onscreen: the window on the screen (only with the person's yes: it
// shows a window), for the drawables as a screen gives them back; off every
// screen macOS gives them back at once.
const ONSCREEN = argv.includes('--onscreen') ? argv.splice(argv.indexOf('--onscreen'), 1) && true : false;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAC = path.resolve(HERE, '..');
const REPO = path.resolve(MAC, '..', '..');
const APP = testApp(process.env.BENCH_APP || path.join(MAC, 'build', 'RavenryMac.app')).app;
fs.mkdirSync(path.join(REPO, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(REPO, '.tmp', 'mrb.'));
const OUT = path.resolve(argv[0] || tmp);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const user = path.join(tmp, 'user'), run = path.join(tmp, 'run'), state = path.join(tmp, 'state');
for (const d of [user, run, state]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(user, '.zshrc'), "PROMPT='~ > '\n");
fs.writeFileSync(path.join(user, '.zshenv'), 'skip_global_compinit=1\n');
const env = { HOME: user, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: run, RAVENRY_STATE_DIR: state, RAVENRY_DESKTOP_DATA: path.join(tmp, 'desktop') };

const daemons = [];
async function serve(bin) {
  const v = JSON.parse(execFileSync(bin, ['version', '--json'], { env, encoding: 'utf8' })).version;
  daemons.push(spawn(bin, ['serve'], { env, stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, `daemon-${v}.log`), 'w')] }));
  const s = path.join(run, `ravenryd-${v.replace(/[^A-Za-z0-9._-]/g, '_')}.sock`);
  for (let i = 0; !fs.existsSync(s); i++) { if (i > 200) throw new Error(`the daemon ${v} did not start`); await sleep(50); }
  return { bin, s, v };
}
let sock = null, two = null;
if (OLD) {
  // This tree's ravenryd as the next version (build.sh's way), in the test's folders with Go's own caches.
  const ver = JSON.parse(fs.readFileSync(path.join(REPO, 'apps', 'desktop', 'package.json'), 'utf8')).version;
  const NEW = path.join(tmp, 'new-ravenryd');
  const go = Object.fromEntries(['GOCACHE', 'GOPATH', 'GOMODCACHE', 'GOROOT'].map((k) => [k, execFileSync('go', ['env', k], { encoding: 'utf8' }).trim()]));
  execFileSync('/bin/sh', ['-c', 'pc=$(scripts/libghostty.sh) && PKG_CONFIG_PATH=$pc CGO_CPPFLAGS="-DRAVENRY_LIBGHOSTTY=$(basename "$(dirname "$(dirname "$pc")")")" go build -ldflags "-X main.version=$VER" -o "$OUT" ./cmd/ravenryd'],
    { cwd: path.join(REPO, 'daemon'), env: { ...env, PATH: process.env.PATH, ...go, VER: ver, OUT: NEW }, stdio: ['ignore', 'ignore', 'inherit'] });
  const o = await serve(OLD), n = await serve(NEW);
  two = { o, n };
  // The tabs by age: the front daemon's shell first (the bench types its busy loop in the first tab).
  const order = FRONT === 'new' ? [n, o, n, o] : [o, n, o, n];
  for (const [i, d] of order.entries()) {
    execFileSync(d.bin, ['new', '--socket', d.s, '--label', 'ravenry.kind=shell', '--cwd', user, '--name', `shell-${i + 1}`, '--json', '--', '/bin/zsh', '-l'], { env });
    await sleep(30);
  }
} else {
  sock = (await serve(path.join(APP, 'Contents', 'MacOS', 'ravenryd'))).s;
}
const port = 47900 + Math.floor(Math.random() * 90);
const hub = await startDemoHub({ dir: path.join(tmp, 'hub'), port });
const result = path.join(OUT, 'bench.json');
fs.rmSync(result, { force: true });
const app = spawn(path.join(APP, 'Contents', 'MacOS', 'RavenryMac'), ['--offscreen', ...(sock ? ['--socket', sock] : []), '--bench', result, '--bench-resize', ...(ONSCREEN ? ['--bench-onscreen'] : [])], {
  env: { ...env, RAVENRY_HUB_URL: hub.url, RAVENRY_BENCH_CONTENT: CONTENT },
  stdio: ['ignore', 'ignore', fs.openSync(path.join(OUT, 'app-stderr.log'), 'w')],
});
let exited = false;
app.on('exit', () => { exited = true; });
const t0 = Date.now();
while (!exited && Date.now() - t0 < 120000) await sleep(100);
if (!exited) app.kill();
// --daemons: which daemon's pane the busy loop ran in (its screen).
let busyIn = '';
if (two) {
  for (const d of [two.o, two.n]) {
    const l = JSON.parse(execFileSync(d.bin, ['ls', '--socket', d.s, '--json'], { env, encoding: 'utf8' }));
    for (const p of l.panes || l) if (execFileSync(d.bin, ['capture', p.id, '--socket', d.s], { env, encoding: 'utf8' }).includes('busy ')) busyIn = d.v;
  }
}
hub.stop();
for (const d of daemons) d.kill();
const log = path.join(user, 'Library', 'Logs', 'Ravenry', 'app.log');
if (fs.existsSync(log)) fs.copyFileSync(log, path.join(OUT, 'app.log'));
let r;
try { r = JSON.parse(fs.readFileSync(result, 'utf8')); } catch { console.log(`resizebench: no result; see ${OUT}`); process.exit(1); }
if (r.error) { console.log('resizebench: error:', r.error.slice(0, 300)); process.exit(1); }
const d = r.resize;
const s = (x, u = 'ms') => `median ${(x.median ?? 0).toFixed(2)}, p95 ${(x.p95 ?? 0).toFixed(2)}, max ${(x.max ?? 0).toFixed(2)} ${u} (n ${x.n ?? 0})`;
if (two) console.log(`two daemons: ${two.o.v} and ${two.n.v}; the busy tab in front is ${busyIn || 'in neither'}'s`);
console.log(`window: ${d.tabs} tabs, sidebar ${d.sidebar_shown ? 'shown' : 'folded'} (hub rows ${d.hub_rows}), panel at the end ${d.panel_at_end}`);
console.log(`drag ${d.steps} steps in ${d.seconds.toFixed(2)} s (1440 to 700 pt and back, 120 a second asked)`);
console.log(`  main thread a step: ${s(d.step_ms)}; steps over 16 ms ${d.steps_over_16ms}`);
console.log(`  of which the board's resize: ${s(d.board_resize_ms)}`);
console.log(`  draws a step (in the step): ${s(d.draws_per_step, '')}; steps not drawn at their size ${d.steps_not_drawn_at_their_size}, drawn more than once ${d.steps_drawn_more_than_once}`);
for (const e of d.examples || []) console.log('    ' + e);
console.log(`  draws ${d.draws} (${d.fps.toFixed(0)} a second), gap between draws: ${s(d.draw_gap_ms)}`);
for (const l of d.front_text_tail || []) console.log(`    | ${l.slice(0, 100)}`);
if (d.frame_to_draw_ms) console.log(`  the pane's frames in the drag ${d.frames_in_drag} (content: ${d.content}), a frame to the draw that shows it: ${s(d.frame_to_draw_ms)}`);
// The content check: a frame of the drag short of a tenth or more of the
// rows of text the screen had before it shows a program's redraw half
// done (Claude Code erases every row after a resize, then draws them
// again).
const short = d.content_frames_short;
if (short !== undefined) {
  console.log(`  content check: ${short} of ${d.content_frames_checked} frames in the drag short of a tenth or more of the full screen's ${d.content_full_rows} rows of text (${d.content_frames_held} held)`);
  for (const e of d.content_short_examples || []) console.log('    ' + e);
  if (short > 0) process.exitCode = 1;
}
const bars = d.content_frames_bars;
if (bars !== undefined) {
  console.log(`  bars check: ${bars} frames in the drag and the 600 ms after it with four rows or more ending in a lone character`);
  for (const e of d.content_bars_examples || []) console.log('    ' + e);
  if (bars > 0) process.exitCode = 1;
}
console.log(`  wait for a drawable: ${s(d.drawable_wait_ms)}`);
console.log(`  draws of the tabs not in front: ${d.hidden_tab_draws}; drawn at its size after the drag: ${d.after_end_drawn_at_size}`);
console.log(`  draws put off for want of a free drawable: ${d.draws_put_off_in_drag ?? '-'}`);
if (d.outstanding_at_step) console.log(`  drawables out at a step: ${s(d.outstanding_at_step, '')}; steps begun with a draw not committed ${d.steps_begun_with_a_draw_uncommitted}; step to drawn at its size: ${s(d.step_to_drawn_ms)}`);
if (d.present_to_handler_ms) console.log(`  present to its presented handler: ${s(d.present_to_handler_ms)}, ${d.presents_dropped} with no presented time`);
if (d.burst_4_draws_ms !== undefined) console.log(`four draws in one turn: ${d.burst_4_draws_ms.toFixed(1)} ms on the main thread, ${d.burst_put_off} put off, the owed draw done: ${d.burst_owed_draw_done}`);
console.log(`  stall log lines: ${d.stall_log_lines}`);
for (const e of d.stall_log_examples || []) console.log('    ' + e);
console.log(`the stall log writes its line (a made-up stall): ${r.stall_log_written}`);
console.log(`resizebench: files in ${OUT}`);
