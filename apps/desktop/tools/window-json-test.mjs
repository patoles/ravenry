#!/usr/bin/env node
// A bad window.json never blocks a launch, and the app never writes one:
//   1. a window.json whose pinned sessions, order, splits, active tab and
//      selected session hold nulls and numbers (pinned: [null] is what a
//      Review view with no session used to leave): the app still becomes
//      ready, with a shell in front;
//   2. a Review view asked for with no session (setView({ kind: 'review' }))
//      writes no null pin: window.json's pinned holds only session keys;
//   3. a window.json that is JSON but not an object (null): ready too.
//
//   node build.mjs && node tools/window-json-test.mjs
//
// Offscreen, in a throwaway HOME, data and runtime folder, with a hub URL
// nobody answers.
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runApp, stopDaemons } from './run-app.mjs';

guardSpawns();
const HERE = path.dirname(new URL(import.meta.url).pathname);
const BIN = path.resolve(process.env.RAVENRYD || path.join(HERE, '..', '..', '..', 'daemon', 'ravenryd'));
if (!fs.existsSync(BIN)) { console.error(`no ravenryd at ${BIN}`); process.exit(1); }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rvwj-'));
const home = path.join(root, 'h');
const rt = path.join(root, 'r');
const work = path.join(root, 'w');
for (const d of [home, rt, work]) fs.mkdirSync(d, { recursive: true });
fs.chmodSync(rt, 0o700);
const data = path.join(root, 'data');
fs.mkdirSync(data, { recursive: true });
const file = path.join(data, 'window.json');
const env = { RAVENRY_SERVICE: 'off', RAVENRY_DESKTOP_DATA: data, RAVENRY_UPDATES: '0' };
const shell = fs.existsSync('/bin/bash') ? '/bin/bash --noprofile --norc' : '/bin/sh';
let fails = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  ' + JSON.stringify(detail).slice(0, 1200) : ''}`); if (!ok) fails++; };
const out = (name) => path.join(work, `${name}.json`);
const read = (name) => { try { return JSON.parse(fs.readFileSync(out(name), 'utf8')); } catch { return null; } };
const hints = { hintsDone: { 'agent-pane': true, 'needs-you': true, pick: true } };
const launched = (name) => ({ save: { expr: `({ ready: document.body.dataset.ready || null, tabs: window.__ravenry ? window.__ravenry.S.tabs.map((t) => ({ kind: t.kind, key: t.key })) : null, view: window.__ravenry ? window.__ravenry.S.view.kind : null })`, out: out(name) } });
const run = (name, steps, more = {}) => runApp({ name, work, rt, bin: BIN, home, hubUrl: 'http://127.0.0.1:9', env, shell, width: 1000, height: 700, steps, ...more });

try {
  // 1 and 2.
  fs.writeFileSync(file, JSON.stringify({ ...hints, pinned: [null, 7, '', { key: 'x' }], order: [null, 3], splits: [null, 4, { host: null }], active: 9, selected: { key: null, pane: 5 } }, null, 2));
  await run('bad', [
    { until: 'document.body.dataset.ready', timeout: 30000 },
    { until: 'document.body.dataset.ready !== "1" || window.__ravenry.S.tabs.length', timeout: 15000, soft: true },
    launched('bad'),
    { js: `window.__ravenry.setView({ kind: 'review' })` },
    { sleep: 300 },
    { save: { expr: `window.__ravenry.S.tabs.map((t) => ({ kind: t.kind, key: t.key }))`, out: out('after-review') } },
    { sleep: 500 },
  ]);
  const a = read('bad');
  check('a window.json with pinned: [null] and other bad entries: the launch becomes ready', a?.ready === '1', a);
  check('... with a shell in front and no tab from the bad entries', !!a && a.tabs?.length > 0 && a.tabs.every((t) => t.kind === 'shell'), a);
  const ar = read('after-review');
  check('setView({ kind: "review" }) with no session adds no tab', Array.isArray(ar) && ar.every((t) => t.kind === 'shell'), ar);
  let w = null;
  try { w = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* below */ }
  check('window.json after: pinned holds only session keys (no null)', !!w && Array.isArray(w.pinned) && w.pinned.every((k) => typeof k === 'string' && k), w && w.pinned);
  // 3. (hints: true, so run-app.mjs leaves the file as it is)
  fs.writeFileSync(file, 'null\n');
  await run('null', [{ until: 'document.body.dataset.ready', timeout: 30000 }, launched('null')], { hints: true });
  const b = read('null');
  check('a window.json that is null: the launch becomes ready', b?.ready === '1', b);
} catch (e) {
  check('the app ran its steps', false, String(e.message || e).slice(0, 2000));
} finally {
  stopDaemons(BIN, rt);
  if (fails) console.log(`kept for its output: ${root}`); else fs.rmSync(root, { recursive: true, force: true });
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
