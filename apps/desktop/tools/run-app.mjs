// Runs the built app offscreen (never on screen) with a driver plan
// (driver.cjs), in a throwaway HOME, data folder and daemon runtime folder.
// Every ravenryd, hub and app a tool here starts is checked first
// (tools/test-env.mjs): none starts with a folder of the real user's.
import { guardSpawns, STUB_PS, paneVarsIn } from '../../../tools/test-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

guardSpawns();

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP = path.resolve(HERE, '..');
// Electron from node_modules, looked up only when a run needs it (a
// packaged app's check runs without it installed).
const electron = () => createRequire(import.meta.url)('electron');

/**
 * opts: name, work (a folder for its files), rt (the daemon runtime folder),
 * bin (ravenryd; none: the app finds its own), cli (the ravenryd the steps'
 * shells run as $SMOKE_RAVENRYD, default bin), exe (a packaged app's
 * executable instead of Electron on this folder), home, hubUrl, steps,
 * width, height, shell (the new-shell command), env (more variables).
 */
export async function runApp(opts) {
  const { name, work, rt, bin, home, hubUrl, steps, width = 1440, height = 900, shell = 'zsh -f', env: more = {} } = opts;
  const plan = path.join(work, `${name}.json`);
  fs.writeFileSync(plan, JSON.stringify({ steps }));
  const env = {
    // A plain PATH: nothing of this machine's own tools (assistants, shims) is found.
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
    ...(bin ? { RAVENRYD: bin } : {}), SMOKE_RAVENRYD: opts.cli || bin, RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: path.join(work, 'state'),
    RAVENRY_HUB_URL: hubUrl, RAVENRY_DESKTOP_DATA: path.join(work, `app-${name}`),
    RAVENRY_NEW_SHELL: shell, PS1: 'you@mac %1~ %# ',
    // A pane takes only the account's variables from its daemon
    // (daemon/internal/pane accountVar), and these, named on purpose.
    RAVENRY_PANE_PASS: 'PS1,SMOKE_RAVENRYD',
    RAVENRY_OFFSCREEN: '1', RAVENRY_THEME: 'dark', RAVENRY_WIDTH: String(width), RAVENRY_HEIGHT: String(height),
    RAVENRY_DRIVER: path.join(HERE, 'driver.cjs'), RAVENRY_DRIVE: plan, RAVENRY_DRIVE_LOG: process.env.RAVENRY_DRIVE_LOG || '',
    // A hub the app starts lists the stand-in ps's processes, never this
    // machine's own (tools/test-env.mjs).
    MC_PS_BIN: STUB_PS, MC_LSOF_BIN: STUB_PS,
    // The X server (xvfb-run sets DISPLAY and XAUTHORITY) and the user's runtime folder.
    ...Object.fromEntries(['DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR'].filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
    ...more,
  };
  // The one-time hints (F) are for a person's first times: a run that is
  // not about them starts with them all dismissed, so none covers what it
  // clicks (opts.hints: true keeps them).
  if (!opts.hints) {
    const f = path.join(env.RAVENRY_DESKTOP_DATA, 'window.json');
    let w = {};
    try { w = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* none yet */ }
    if (!w.hintsDone) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ ...w, hintsDone: { 'agent-pane': true, 'needs-you': true, pick: true } }, null, 2) + '\n'); }
  }
  // Linux CI has no setuid sandbox helper.
  const noSandbox = process.platform === 'linux' ? ['--no-sandbox'] : [];
  // RAVENRY_CHECK_EXE: a packaged app's executable (a test twin) for the
  // runs of a tool that names none, so any tool here checks a packed build.
  const exe = opts.exe || process.env.RAVENRY_CHECK_EXE || null;
  const child = exe
    ? spawn(exe, noSandbox, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(electron(), [APP, ...noSandbox], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; if (process.env.RAVENRY_DRIVE_LOG) process.stdout.write(d); });
  child.stderr.on('data', (d) => { log += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs || 180000);
  const code = await new Promise((r) => child.on('exit', r));
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${name}: the app exited with ${code}\n${log.slice(-4000)}`);
  // What the app really ran with: no terminal pane's variables, and no
  // Ravenry variable the tool did not name (one inherited from somewhere).
  let got = null;
  try { got = JSON.parse(fs.readFileSync(plan + '.env.json', 'utf8')); } catch { /* below */ }
  if (!Array.isArray(got)) throw new Error(`${name}: the app did not record its environment (${plan}.env.json)`);
  const bad = got.filter((k) => paneVarsIn({ [k]: 1 }).length || (k.startsWith('RAVENRY_') && !(k in env)));
  appEnvs.push({ name, vars: got, bad });
  if (bad.length) throw new Error(`${name}: the app ran with variables it must not have: ${bad.join(', ')}`);
  return log;
}

/** Each app runApp started: the Ravenry and terminal variables it ran with, and any it must not have had. */
export const appEnvs = [];

/** The environment for a ravenryd command a tool runs on a test's daemons: no folder of the real user's. */
export function cliEnv(rt, home, state = path.join(home, 'state')) {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, LANG: 'en_US.UTF-8', RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: state };
}

/** Stops the daemons in a runtime folder (the ones the run started). */
export function stopDaemons(bin, rt) {
  try {
    const out = execFileSync(bin, ['daemons', '--json', '--no-start'], { env: cliEnv(rt, rt), encoding: 'utf8' });
    for (const d of JSON.parse(out)) { try { process.kill(d.pid, 'SIGTERM'); } catch { /* gone */ } }
  } catch { /* none */ }
}
