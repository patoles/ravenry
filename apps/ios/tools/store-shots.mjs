#!/usr/bin/env node
// The App Store's screenshots, from the real app's demo on a simulator,
// headless (`xcrun simctl boot`, never Simulator.app): the same moments as
// the Play pictures (docs/store/play/README.md), dark, the status bar at
// 9:41 with a full battery.
//
//   node tools/store-shots.mjs --udid <booted simulator> --out <dir> [--prefix iphone] [--sideways]
//
// It builds the app (scripts/build.sh), runs Tests/RavenryUITests/StoreShots
// (which opens the demo and does the finger work), drives the board by
// script in its page (TestDrive) and takes each picture with `simctl io
// screenshot` into <out>/<prefix>-<n>-<name>.png. A simulator of the size
// the store asks for: iPhone 17 Pro Max (1320 x 2868) or iPad Pro 13-inch
// (2064 x 2752).
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const IOS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const UDID = opt('--udid');
const OUT = path.resolve(opt('--out', path.join(IOS, 'build', 'store-shots')));
const PREFIX = opt('--prefix', 'iphone');
if (!UDID) { console.error('give --udid of a booted simulator'); process.exit(2); }
const SIG = path.join(IOS, 'build', `store-sig-${UDID}`);
fs.rmSync(SIG, { recursive: true, force: true });
fs.mkdirSync(path.join(SIG, 'drive'), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const simctl = (...a) => execFileSync('xcrun', ['simctl', ...a], { encoding: 'utf8' });
const env = { ...process.env };
for (const k of ['RAVENRY_SOCKET', 'RAVENRY_PANE', 'RAVENRY_HUB_URL']) delete env[k];

// A line of script in the board's page; its answer as JSON text.
let n = 0;
async function js(code, secs = 8) {
  const base = path.join(SIG, 'drive', `${++n}`);
  fs.writeFileSync(base + '.tmp', code);
  fs.renameSync(base + '.tmp', base + '.js');
  for (let i = 0; i < secs * 10; i++) { await sleep(100); if (fs.existsSync(base + '.out')) return fs.readFileSync(base + '.out', 'utf8'); }
  return null;
}
async function until(secs, code) { for (let i = 0; i < secs * 4; i++) { if ((await js(code)) === 'true') return true; await sleep(250); } return false; }
// What only a finger does (StoreShots.swift): its answer.
async function cmd(line, secs = 30) {
  fs.rmSync(path.join(SIG, 'ack'), { force: true });
  fs.writeFileSync(path.join(SIG, 'cmd.tmp'), line);
  fs.renameSync(path.join(SIG, 'cmd.tmp'), path.join(SIG, 'cmd'));
  for (let i = 0; i < secs * 10; i++) { await sleep(100); const p = path.join(SIG, 'ack'); if (fs.existsSync(p)) { const a = fs.readFileSync(p, 'utf8'); fs.rmSync(p); return a; } }
  return 'no answer';
}
const shots = [];
function shot(k, name) {
  const to = path.join(OUT, `${PREFIX}-${k}-${name}.png`);
  execFileSync('xcrun', ['simctl', 'io', UDID, 'screenshot', to], { stdio: 'ignore' });
  shots.push(to);
  console.log(to);
}
const click = (sel) => js(`const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true;`);
// A project: its chip on the phone board, its row in the iPad's wide one.
const project = (id) => js(`const e = document.querySelector('.row[data-id="${id}"]') || document.querySelector('#pchips .pchip[data-id="${id}"]'); if (!e) return false; e.click(); return true;`);

execFileSync(path.join(IOS, 'scripts', 'build.sh'), [], { env, stdio: ['ignore', 'ignore', 'inherit'] });
try { simctl('uninstall', UDID, 'dev.ravenry.ios'); } catch { /* not there */ }
simctl('ui', UDID, 'appearance', 'dark');
simctl('status_bar', UDID, 'override', '--time', '9:41', '--batteryState', 'charged', '--batteryLevel', '100', '--wifiBars', '3', '--cellularMode', 'notSupported', '--operatorName', '');

const test = spawn('xcodebuild', ['-project', path.join(IOS, 'Ravenry.xcodeproj'), '-scheme', 'RavenryE2E', '-configuration', 'Debug',
  '-destination', `id=${UDID}`, '-derivedDataPath', path.join(IOS, 'build', 'DerivedData'),
  '-only-testing:RavenryUITests/StoreShots/testTheDemoForTheStore', 'test', '-quiet'],
{ env: { ...env, TEST_RUNNER_RAVENRY_STORE_SHOTS: '1', TEST_RUNNER_RAVENRY_SIG: SIG }, stdio: ['ignore', fs.openSync(path.join(SIG, 'test.log'), 'w'), fs.openSync(path.join(SIG, 'test.err'), 'w')] });
let exited = false;
test.on('exit', () => { exited = true; });
for (let i = 0; i < 600 && !fs.existsSync(path.join(SIG, 'ready')); i++) { if (exited) break; await sleep(500); }
if (!fs.existsSync(path.join(SIG, 'ready'))) { console.error(`the test did not open the demo (${SIG}/test.log)`); test.kill(); process.exit(1); }
const ok = (what, v) => { if (!v) { console.error(`store-shots: ${what}`); } return v; };
ok('the demo board', await until(30, "return !!document.querySelector('.rv-demo') && document.body.innerText.includes('paper-boat');"));
// --sideways: an iPad turned (the wide board at its widest); simctl takes the pictures sideways too.
const SIDEWAYS = args.includes('--sideways');
if (SIDEWAYS) { ok('sideways', (await cmd('sideways')) === 'ok'); }
await sleep(1500);

// The pictures, numbered as the Play ones (docs/store/play/README.md): 1 the
// question, 2 the board, 3 the pick, 4 the command, 5 the alert; 6 a live
// screen full. Taken in the order the demo allows (its alert comes once,
// 6 s in; the pick last, since it is answered on its own screen).

// 5. The question (notes-app) as its alert shows it, with its answers.
ok('the question', await until(20, 'return window.ravenryDemo.asked();'));
const banner = await cmd('banner Demo: notes-app needs you');
if (ok(`the alert (${banner})`, banner === 'ok')) { await sleep(800); shot(5, 'alert'); }
await cmd('front');
await sleep(1000);

// 1. The question's card in its project: its answers and a field for your own words.
await project('notes-app');
await sleep(1200);
await js("const e = document.querySelector('[data-act=cp-choice]'); if (e) e.scrollIntoView({ block: 'center' }); return !!e;");
await sleep(600);
shot(1, 'question');

// 2. The board on paper-boat: Needs you, and the session's live screen.
await project('paper-boat');
await sleep(1500);
shot(2, 'board');

// 6. Its live screen, full.
await js("const b = document.querySelector('#lv-exp'); if (b && b.getClientRects().length && innerWidth >= 1000) b.click(); else document.querySelector('#lv-scroll').click(); return true;");
ok('the live screen full', await until(5, "return !document.querySelector('#lv-fs').hidden;"));
await sleep(1500);
shot(6, 'live');
await js('window.ravenryBack(); return true;');
await sleep(1000);

// 4. The command to approve: recipe-box's, its warning, Refuse and Run.
await project('recipe-box');
await sleep(1200);
await js("const e = document.querySelector('[data-act=cp-run]'); if (e) e.scrollIntoView({ block: 'center' }); return !!e;");
await sleep(800);
shot(4, 'approve');

// 3. The pick: three renders, B, the spray circled and a note pinned to it.
await project('paper-boat');
await sleep(1000);
await click('[data-act=cp-open]');
ok('the pick', await until(10, "return document.querySelectorAll('.ptrack img').length === 3 && [...document.querySelectorAll('.ptrack img')].every((i) => i.complete && i.naturalWidth > 0);"));
await js("const t = document.querySelector('.ptrack'); t.scrollLeft = t.clientWidth; return true;");
ok('B', await until(5, 'return /B, 2 of 3/.test(document.body.innerText);'));
await js("[...document.querySelectorAll('button')].find((x) => /Circle a part/.test(x.textContent)).click(); return true;");
await sleep(1200);
// A ring round the spray, drawn as a finger draws it (pointer events on the picture's stage).
ok('the circle', (await js(`
  const st = document.querySelector('.pzv-stage'); const img = st && st.querySelector('img');
  if (!img) return false;
  const r = img.getBoundingClientRect(), cx = r.left + 0.545 * r.width, cy = r.top + 0.33 * r.height, rad = 0.1 * r.width;
  const at = (k) => ({ clientX: cx + rad * Math.cos(k) * 1.15, clientY: cy + rad * Math.sin(k), pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true });
  st.dispatchEvent(new PointerEvent('pointerdown', at(-2)));
  for (let k = -2; k <= -2 + 2 * Math.PI * 1.04; k += 0.12) st.dispatchEvent(new PointerEvent('pointermove', at(k)));
  st.dispatchEvent(new PointerEvent('pointerup', at(-2 + 2 * Math.PI * 1.04)));
  return true;`)) === 'true');
await sleep(1000);
await js("const f = document.querySelector('.pnote'); if (!f) return false; f.value = 'This, but less spray at the bow. It hides the boat.'; f.dispatchEvent(new Event('input', { bubbles: true })); f.blur(); return true;");
await sleep(1000);
shot(3, 'pick');

await cmd('done');
for (let i = 0; i < 120 && !exited; i++) await sleep(500);
simctl('status_bar', UDID, 'clear');
console.log(`${shots.length} pictures in ${OUT}`);
