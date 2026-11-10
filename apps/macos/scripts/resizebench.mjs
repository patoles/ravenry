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
//
// BENCH_APP: another build of the app (default apps/macos/build/RavenryMac.app).
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDemoHub } from '../../desktop/tools/demo-hub.mjs';

guardSpawns();
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAC = path.resolve(HERE, '..');
const REPO = path.resolve(MAC, '..', '..');
const APP = process.env.BENCH_APP || path.join(MAC, 'build', 'RavenryMac.app');
fs.mkdirSync(path.join(REPO, '.tmp'), { recursive: true });
const tmp = fs.mkdtempSync(path.join(REPO, '.tmp', 'mrb.'));
const OUT = path.resolve(process.argv[2] || tmp);
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const user = path.join(tmp, 'user'), run = path.join(tmp, 'run'), state = path.join(tmp, 'state');
for (const d of [user, run, state]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(user, '.zshrc'), "PROMPT='~ > '\n");
fs.writeFileSync(path.join(user, '.zshenv'), 'skip_global_compinit=1\n');
const env = { HOME: user, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: run, RAVENRY_STATE_DIR: state, RAVENRY_DESKTOP_DATA: path.join(tmp, 'desktop') };

const daemon = spawn(path.join(APP, 'Contents', 'MacOS', 'ravenryd'), ['serve'], { env, stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, 'daemon.log'), 'w')] });
const sock = path.join(run, 'ravenryd-0.0.0-dev.sock');
for (let i = 0; !fs.existsSync(sock); i++) { if (i > 100) throw new Error('the daemon did not start'); await sleep(50); }
const port = 47900 + Math.floor(Math.random() * 90);
const hub = await startDemoHub({ dir: path.join(tmp, 'hub'), port });
const result = path.join(OUT, 'bench.json');
fs.rmSync(result, { force: true });
const app = spawn(path.join(APP, 'Contents', 'MacOS', 'RavenryMac'), ['--offscreen', '--socket', sock, '--bench', result, '--bench-resize'], {
  env: { ...env, RAVENRY_HUB_URL: hub.url },
  stdio: ['ignore', 'ignore', fs.openSync(path.join(OUT, 'app-stderr.log'), 'w')],
});
let exited = false;
app.on('exit', () => { exited = true; });
const t0 = Date.now();
while (!exited && Date.now() - t0 < 120000) await sleep(100);
if (!exited) app.kill();
hub.stop();
daemon.kill();
const log = path.join(user, 'Library', 'Logs', 'Ravenry', 'app.log');
if (fs.existsSync(log)) fs.copyFileSync(log, path.join(OUT, 'app.log'));
let r;
try { r = JSON.parse(fs.readFileSync(result, 'utf8')); } catch { console.log(`resizebench: no result; see ${OUT}`); process.exit(1); }
if (r.error) { console.log('resizebench: error:', r.error.slice(0, 300)); process.exit(1); }
const d = r.resize;
const s = (x, u = 'ms') => `median ${(x.median ?? 0).toFixed(2)}, p95 ${(x.p95 ?? 0).toFixed(2)}, max ${(x.max ?? 0).toFixed(2)} ${u} (n ${x.n ?? 0})`;
console.log(`window: ${d.tabs} tabs, sidebar ${d.sidebar_shown ? 'shown' : 'folded'} (hub rows ${d.hub_rows}), panel at the end ${d.panel_at_end}`);
console.log(`drag ${d.steps} steps in ${d.seconds.toFixed(2)} s (1440 to 700 pt and back, 120 a second asked)`);
console.log(`  main thread a step: ${s(d.step_ms)}; steps over 16 ms ${d.steps_over_16ms}`);
console.log(`  of which the board's resize: ${s(d.board_resize_ms)}`);
console.log(`  draws a step (in the step): ${s(d.draws_per_step, '')}; steps not drawn at their size ${d.steps_not_drawn_at_their_size}, drawn more than once ${d.steps_drawn_more_than_once}`);
for (const e of d.examples || []) console.log('    ' + e);
console.log(`  draws ${d.draws} (${d.fps.toFixed(0)} a second), gap between draws: ${s(d.draw_gap_ms)}`);
console.log(`  wait for a drawable: ${s(d.drawable_wait_ms)}`);
console.log(`  draws of the tabs not in front: ${d.hidden_tab_draws}; drawn at its size after the drag: ${d.after_end_drawn_at_size}`);
console.log(`  draws put off for want of a free drawable: ${d.draws_put_off_in_drag ?? '-'}`);
if (d.burst_4_draws_ms !== undefined) console.log(`four draws in one turn: ${d.burst_4_draws_ms.toFixed(1)} ms on the main thread, ${d.burst_put_off} put off, the owed draw done: ${d.burst_owed_draw_done}`);
console.log(`  stall log lines: ${d.stall_log_lines}`);
for (const e of d.stall_log_examples || []) console.log('    ' + e);
console.log(`the stall log writes its line (a made-up stall): ${r.stall_log_written}`);
console.log(`resizebench: files in ${OUT}`);
