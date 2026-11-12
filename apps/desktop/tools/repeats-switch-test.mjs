#!/usr/bin/env node
// PAGE-018 in the Electron app: Settings, Behavior, Rule suggestions (this
// Mac) turns the board's daily run on and off (the hub's GET and POST
// /api/settings/repeats). The built app offscreen in a throwaway HOME, data
// and runtime folder, on the demo board (tools/demo-hub.mjs, 127.0.0.1)
// started with MC_REPEATS_AUTO unset so the switch is the person's;
// tools/repeats-driver.cjs presses the box and reads the board's answer and
// its projects.json.
//
//   node build.mjs && node tools/repeats-switch-test.mjs [OUT]
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP, runApp, stopDaemons } from './run-app.mjs';
import { startDemoHub, freePort } from './demo-hub.mjs';

guardSpawns();
const OUT = path.resolve(process.argv[2] || path.join(APP, '.tmp', 'repeats-switch'));
const WORK = path.join(OUT, '.work');
const BIN = process.env.RAVENRYD || path.resolve(APP, '..', '..', 'daemon', 'ravenryd');
if (!fs.existsSync(BIN)) { console.error(`no ravenryd at ${BIN}; build it (daemon/README.md) or set RAVENRYD`); process.exit(1); }
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const RT = fs.mkdtempSync(path.join(process.env.RAVENRY_SHORT_TMP || os.tmpdir(), 'rvr-'));
fs.chmodSync(RT, 0o700);
const home = path.join(WORK, 'home');
fs.mkdirSync(home, { recursive: true });
const hub = await startDemoHub({ dir: path.join(WORK, 'hub'), port: await freePort(), env: { MC_REPEATS_AUTO: '' } });
let failed = 1;
try {
  fs.rmSync(path.join(OUT, 'checks.json'), { force: true });
  await runApp({
    name: 'repeats', work: WORK, rt: RT, bin: BIN, home, hubUrl: hub.url, steps: [],
    env: { RAVENRY_DRIVER: path.join(APP, 'tools', 'repeats-driver.cjs'), REPEATS_OUT: OUT, REPEATS_REGISTRY: path.join(hub.home, '.ravenry', 'projects.json') },
  });
  const checks = JSON.parse(fs.readFileSync(path.join(OUT, 'checks.json'), 'utf8'));
  for (const c of checks) console.log(`${c.ok ? 'pass' : 'FAIL'} ${c.name}${c.detail ? ': ' + c.detail : ''}`);
  failed = checks.filter((c) => !c.ok).length + (checks.length < 6 ? 1 : 0);
  console.log(`repeats-switch-test: ${checks.length} checks, ${failed} failed; pictures in ${OUT}`);
} finally {
  hub.stop();
  stopDaemons(BIN, RT);
  fs.rmSync(RT, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
