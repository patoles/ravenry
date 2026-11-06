#!/usr/bin/env node
// The app end to end, offscreen (CI runs it on Linux under xvfb): it finds
// no daemon and starts one, shows the first launch with no board running,
// opens a real shell, types, pastes, checks the pane's size, opens a second
// shell and switches back (a fresh snapshot brings the first one's screen
// back), follows `ravenryd focus` to the second, shows the status an
// assistant's hook reports on its tab, and closes a tab, which ends its
// pane in the daemon. Then checkpoints (smoke-steps.mjs checkpointSteps):
// a real ask, approve and secret run in the shell, the window shows each
// card, the test answers in the window, and the pane gets the answer: the
// approved command runs and the secret reaches a program that checks it
// without printing it. The secret is then searched for everywhere the
// window and the daemon could have kept it.
//
//   node build.mjs && RAVENRYD=../../daemon/ravenryd node tools/smoke.mjs [outDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { APP, runApp, stopDaemons } from './run-app.mjs';
import { checkpointSteps, smokeSteps } from './smoke-steps.mjs';

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
// A made-up secret, different on each run; the program in the pane checks
// it against its checksum, so the secret itself is never on a command line.
const SECRET = 'smoke-' + crypto.randomBytes(12).toString('base64url');
const SUM = execFileSync('sh', ['-c', 'printf %s "$1" | cksum', 'sh', SECRET], { encoding: 'utf8' }).trim();
const steps = [...smokeSteps(OUT), ...checkpointSteps(OUT, WORK, { secret: SECRET, sum: SUM })];

let failed = false;
try {
  await runApp({ name: 'smoke', work: WORK, rt: RT, bin: BIN, home: HOME, hubUrl: 'http://127.0.0.1:9', steps, shell, width: 1200, height: 760, env: { PS1: '$ ' } });
  const before = JSON.parse(fs.readFileSync(path.join(WORK, 'before-close.json'), 'utf8'));
  const ls = JSON.parse(execFileSync(BIN, ['ls', '--all', '--json', '--no-start'], { env: { ...process.env, RAVENRY_RUNTIME_DIR: RT }, encoding: 'utf8' }));
  const ids = (Array.isArray(ls) ? ls : ls.panes || []).map((p) => p.id);
  const kept = before.tabs.find((p) => p !== before.active);
  if (ids.includes(before.active)) throw new Error(`the closed tab's pane ${before.active} is still in the daemon: ${ids}`);
  if (!ids.includes(kept)) throw new Error(`the open tab's pane ${kept} is gone: ${ids}`);
  // Each checkpoint was answered from this window, and the secret is nowhere:
  // not in the window (its state, page, fields), not in the daemon's checkpoints,
  // not on the asking pane's screen.
  const seen = JSON.parse(fs.readFileSync(path.join(WORK, 'checkpoints.json'), 'utf8'));
  const cps = JSON.parse(execFileSync(BIN, ['checkpoints', '--all', '--json'], { env: { ...process.env, RAVENRY_RUNTIME_DIR: RT }, encoding: 'utf8' }));
  const list = Array.isArray(cps) ? cps : cps.checkpoints || [];
  const kinds = list.map((c) => `${c.kind}:${c.state}:${c.answer && c.answer.by}`).sort();
  const want = ['approve:answered:desktop', 'ask:answered:desktop', 'ask:answered:desktop', 'secret:answered:desktop'];
  if (JSON.stringify(kinds) !== JSON.stringify(want)) throw new Error(`checkpoints: ${kinds.join(', ')}; want ${want.join(', ')}`);
  if (!list.some((c) => c.kind === 'secret' && c.answer && c.answer.delivered && c.run && c.run.exit && c.run.exit.code === 0)) throw new Error('the secret did not reach its program');
  const leaks = [['the window', JSON.stringify(seen)], ['the daemon\'s checkpoints', JSON.stringify(cps)], ['the asking pane', execFileSync(BIN, ['capture', before.tabs.find((p) => p !== before.active), '--history', '2000'], { env: { ...process.env, RAVENRY_RUNTIME_DIR: RT }, encoding: 'utf8' })]].filter(([, t]) => t.includes(SECRET) || t.includes(SECRET.slice(6)));
  if (leaks.length) throw new Error(`the secret is in ${leaks.map(([w]) => w).join(', ')}`);
  if (seen.inputs.some((v) => v)) throw new Error('a field still holds text after the answers');
  console.log(`smoke: ok (renderer ${before.renderer}, ${before.cols}x${before.rows}, panes left ${ids.length}, checkpoints ${kinds.length} answered in the window, the secret nowhere)`);
} catch (e) {
  failed = true;
  console.error('smoke: FAILED\n' + (e.stack || e));
} finally {
  stopDaemons(BIN, RT);
  fs.rmSync(RT, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
