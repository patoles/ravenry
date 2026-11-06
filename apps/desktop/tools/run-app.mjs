// Runs the built app offscreen (never on screen) with a driver plan
// (driver.cjs), in a throwaway HOME, data folder and daemon runtime folder.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP = path.resolve(HERE, '..');
const ELECTRON = createRequire(import.meta.url)('electron');

/**
 * opts: name, work (a folder for its files), rt (the daemon runtime folder),
 * bin (ravenryd), home, hubUrl, steps, width, height, shell (the new-shell
 * command), env (more variables).
 */
export async function runApp(opts) {
  const { name, work, rt, bin, home, hubUrl, steps, width = 1440, height = 900, shell = 'zsh -f', env: more = {} } = opts;
  const plan = path.join(work, `${name}.json`);
  fs.writeFileSync(plan, JSON.stringify({ steps }));
  const env = {
    // A plain PATH: nothing of this machine's own tools (assistants, shims) is found.
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
    RAVENRYD: bin, RAVENRY_RUNTIME_DIR: rt, RAVENRY_STATE_DIR: path.join(work, 'state'),
    RAVENRY_HUB_URL: hubUrl, RAVENRY_DESKTOP_DATA: path.join(work, `app-${name}`),
    RAVENRY_NEW_SHELL: shell, PS1: 'you@mac %1~ %# ',
    RAVENRY_OFFSCREEN: '1', RAVENRY_THEME: 'dark', RAVENRY_WIDTH: String(width), RAVENRY_HEIGHT: String(height),
    RAVENRY_DRIVER: path.join(HERE, 'driver.cjs'), RAVENRY_DRIVE: plan, RAVENRY_DRIVE_LOG: process.env.RAVENRY_DRIVE_LOG || '',
    // The X server (xvfb-run sets DISPLAY and XAUTHORITY) and the user's runtime folder.
    ...Object.fromEntries(['DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR'].filter((k) => process.env[k]).map((k) => [k, process.env[k]])),
    ...more,
  };
  // Linux CI has no setuid sandbox helper.
  const args = [APP, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])];
  const child = spawn(ELECTRON, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; if (process.env.RAVENRY_DRIVE_LOG) process.stdout.write(d); });
  child.stderr.on('data', (d) => { log += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs || 180000);
  const code = await new Promise((r) => child.on('exit', r));
  clearTimeout(timer);
  if (code !== 0) throw new Error(`${name}: the app exited with ${code}\n${log.slice(-4000)}`);
  return log;
}

/** Stops the daemons in a runtime folder (the ones the run started). */
export function stopDaemons(bin, rt) {
  try {
    const out = execFileSync(bin, ['daemons', '--json'], { env: { ...process.env, RAVENRY_RUNTIME_DIR: rt }, encoding: 'utf8' });
    for (const d of JSON.parse(out)) { try { process.kill(d.pid, 'SIGTERM'); } catch { /* gone */ } }
  } catch { /* none */ }
}
