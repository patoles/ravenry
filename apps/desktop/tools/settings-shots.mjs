#!/usr/bin/env node
// Screenshots of the Settings window, never on screen: the built app runs
// offscreen in a throwaway HOME, app data and daemon runtime folder, and
// tools/settings-driver.cjs opens Settings from the app menu, uses its
// controls and captures it. Also a real xterm.js in Ravenry Light and
// Ravenry Dark (tools/theme-page.ts).
//
//   node build.mjs && node tools/settings-shots.mjs <outDir>
//
// Writes to <outDir>: settings-appearance-dark.png, -light.png,
// settings-behavior-dark.png, -light.png, settings-import-light.png,
// settings-follow-off-dark.png, theme-ravenry-light.png,
// theme-ravenry-dark.png and checks.json (what the file and the API said).
// Needs ravenryd: RAVENRYD, else ../../daemon/ravenryd.
import { guardSpawns } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { APP, runApp, stopDaemons } from './run-app.mjs';

guardSpawns();

const OUT = path.resolve(process.argv[2] || path.join(APP, '.tmp', 'settings-shots'));
const WORK = path.join(OUT, '.work');
const BIN = process.env.RAVENRYD || path.resolve(APP, '..', '..', 'daemon', 'ravenryd');
if (!fs.existsSync(BIN)) { console.error(`no ravenryd at ${BIN}; build it (daemon/README.md) or set RAVENRYD`); process.exit(1); }
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
const RT = fs.mkdtempSync(path.join(process.env.RAVENRY_SHORT_TMP || os.tmpdir(), 'rvs-'));
fs.chmodSync(RT, 0o700);
const home = path.join(WORK, 'home');
fs.mkdirSync(home, { recursive: true });

// The theme page: one xterm.js in a shipped theme.
const page = path.join(WORK, 'theme-page');
fs.mkdirSync(page, { recursive: true });
await esbuild.build({ entryPoints: { page: path.join(APP, 'tools', 'theme-page.ts') }, bundle: true, platform: 'browser', format: 'iife', target: 'chrome140', outdir: page, absWorkingDir: APP, logLevel: 'warning' });
fs.writeFileSync(path.join(page, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="page.css"></head><body><script src="page.js"></script></body></html>\n');

try {
  const log = await runApp({
    name: 'settings', work: WORK, rt: RT, bin: BIN, home, hubUrl: 'http://127.0.0.1:9',
    steps: [],
    env: {
      RAVENRY_DRIVER: path.join(APP, 'tools', 'settings-driver.cjs'),
      SETTINGS_SHOTS_OUT: OUT,
      SETTINGS_SHOTS_IMPORT: path.join(APP, 'test', 'fixtures', 'themes', 'Harbour Night.itermcolors'),
      SETTINGS_SHOTS_THEME_PAGE: path.join(page, 'index.html'),
    },
  });
  for (const l of log.split('\n')) if (/^(shot|settings:)/.test(l)) console.log(l);
  console.log(fs.readFileSync(path.join(OUT, 'checks.json'), 'utf8'));
} finally {
  stopDaemons(BIN, RT);
}
