#!/usr/bin/env node
// The app end to end, offscreen (CI runs it on Linux under xvfb): it finds
// no daemon and starts one, shows the first launch with no board running,
// opens a real shell, types, pastes, checks the pane's size, opens a second
// shell and switches back (a fresh snapshot brings the first one's screen
// back), follows `ravenryd focus` to the second, shows the status an
// assistant's hook reports on its tab, and closes a tab, which ends its
// pane in the daemon.
//
//   node build.mjs && RAVENRYD=../../daemon/ravenryd node tools/smoke.mjs [outDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP, runApp, stopDaemons } from './run-app.mjs';
import { smokeSteps } from './smoke-steps.mjs';

const OUT = path.resolve(process.argv[2] || path.join(APP, '.tmp', 'smoke'));
const BIN = path.resolve(process.env.RAVENRYD || path.join(APP, '..', '..', 'daemon', 'ravenryd'));
if (!fs.existsSync(BIN)) { console.error(`no ravenryd at ${BIN}`); process.exit(1); }
fs.rmSync(OUT, { recursive: true, force: true });
const WORK = path.join(OUT, '.work');
const HOME = path.join(WORK, 'home');
fs.mkdirSync(HOME, { recursive: true });
const RT = fs.mkdtempSync(path.join(process.env.RAVENRY_SHORT_TMP || os.tmpdir(), 'rvk-'));
fs.chmodSync(RT, 0o700);

// bash without its startup files: the same on a Mac and on Linux.
const shell = fs.existsSync('/bin/bash') ? '/bin/bash --noprofile --norc' : '/bin/sh';
const steps = smokeSteps(OUT);

let failed = false;
try {
  await runApp({ name: 'smoke', work: WORK, rt: RT, bin: BIN, home: HOME, hubUrl: 'http://127.0.0.1:9', steps, shell, width: 1200, height: 760, env: { PS1: '$ ' } });
  const before = JSON.parse(fs.readFileSync(path.join(WORK, 'before-close.json'), 'utf8'));
  const ls = JSON.parse(execFileSync(BIN, ['ls', '--all', '--json', '--no-start'], { env: { ...process.env, RAVENRY_RUNTIME_DIR: RT }, encoding: 'utf8' }));
  const ids = (Array.isArray(ls) ? ls : ls.panes || []).map((p) => p.id);
  const kept = before.tabs.find((p) => p !== before.active);
  if (ids.includes(before.active)) throw new Error(`the closed tab's pane ${before.active} is still in the daemon: ${ids}`);
  if (!ids.includes(kept)) throw new Error(`the open tab's pane ${kept} is gone: ${ids}`);
  console.log(`smoke: ok (renderer ${before.renderer}, ${before.cols}x${before.rows}, panes left ${ids.length})`);
} catch (e) {
  failed = true;
  console.error('smoke: FAILED\n' + (e.stack || e));
} finally {
  stopDaemons(BIN, RT);
  fs.rmSync(RT, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
