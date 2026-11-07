// The packaged app started with a pane's variables (an agent in a pane ran
// `open -a Ravenry`, and macOS's open hands the caller's environment to the
// app): the daemon then takes the window for a program inside that pane,
// never the person (PROTOCOL.md section 4, Who acts as the person), so the
// person's typing goes to that agent and no card can be answered. Such a
// start relaunches the app through LaunchServices with a clean environment
// and no arguments, as the Dock would start it, and exits before it opens a
// window or reaches a daemon. No Electron here, so tests import it.

import fs from 'node:fs';
import path from 'node:path';

/** What marks a process as one of a pane's (PROTOCOL.md section 3, a pane's environment). */
export const PANE_VARS = ['RAVENRY_PANE', 'RAVENRY_SOCKET'] as const;

/**
 * The variables the relaunched app keeps: the account's own, the ones a
 * pane takes from its daemon (daemon/internal/pane accountVar) that a Mac
 * app uses. Everything else goes, so nothing the caller set reaches the new
 * app: no RAVENRY_* (RAVENRY_DRIVER would load a module into it), no
 * ELECTRON_*, NODE_OPTIONS, TERM_PROGRAM, CLAUDE*, SSH_CONNECTION.
 */
const KEEP = new Set(['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LANGUAGE', 'TZ', 'SSH_AUTH_SOCK', '__CF_USER_TEXT_ENCODING']);
const keep = (k: string) => KEEP.has(k) || k.startsWith('LC_');

/** PATH as launchd gives an app started from the Dock or the Finder; a pane's PATH holds the agent's own tool folders. */
export const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * RAVENRY_RELAUNCH_TEST=1, for tools/relaunch-check.mjs only: the self-heal
 * runs in a test run too, the new app keeps these, so it stays in the
 * test's folders and off the person's hub, offscreen and without a
 * service, and it opens in the background (`foreground` instead of 1: it
 * opens as the person's would, without -g, for the release check, which
 * proves the path a real start takes). Honoured only when the data, runtime and state folders are
 * all set, so it never runs on the person's own. It adds nothing an agent
 * could not do with `env -i RAVENRY_DESKTOP_DATA=... open -a Ravenry`, and
 * never keeps a variable that drives the app.
 */
export const TEST_FLAG = 'RAVENRY_RELAUNCH_TEST';
const TEST_KEEP = ['RAVENRY_DESKTOP_DATA', 'RAVENRY_RUNTIME_DIR', 'RAVENRY_STATE_DIR', 'RAVENRY_HUB_URL', 'RAVENRY_SERVICE', 'RAVENRY_SERVICE_LABEL', 'RAVENRY_UPDATES', 'RAVENRY_OFFSCREEN'];

/** The marker the relaunching app leaves in its data folder, for the new one: the loop guard and its log line. */
export const MARKER = 'relaunched-from-pane.json';
/** A marker older than this is a leftover, not this launch's. */
export const MARKER_MS = 60000;

type Env = Record<string, string | undefined>;

/** The pane variables this environment carries (names). */
export function paneVars(env: Env): string[] {
  return PANE_VARS.filter((k) => !!env[k]);
}

export function testRelaunch(env: Env): boolean {
  return (env[TEST_FLAG] === '1' || env[TEST_FLAG] === 'foreground') && !!env.RAVENRY_DESKTOP_DATA && !!env.RAVENRY_RUNTIME_DIR && !!env.RAVENRY_STATE_DIR;
}

/** The relaunched app's environment, and the names of the variables it drops (sorted). */
export function cleanEnv(env: Env): { env: Record<string, string>; dropped: string[] } {
  const test = testRelaunch(env);
  const out: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (keep(k) || (test && TEST_KEEP.includes(k))) out[k] = v;
    else if (k !== 'PATH') dropped.push(k);
  }
  out.PATH = SYSTEM_PATH;
  return { env: out, dropped: dropped.sort() };
}

/** The .app bundle an executable runs from (…/Ravenry.app/Contents/MacOS/Ravenry), or null. */
export function bundleOf(execPath: string): string | null {
  const macos = path.dirname(execPath);
  const contents = path.dirname(macos);
  const bundle = path.dirname(contents);
  if (path.basename(macos) !== 'MacOS' || path.basename(contents) !== 'Contents' || !bundle.endsWith('.app')) return null;
  return bundle;
}

/** What the relaunching app left for the new one, when it is this launch's. */
export interface Marker { pid: number; at: number; dropped: string[] }

export function readMarker(file: string, now = Date.now()): Marker | null {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Marker;
    if (typeof m.at !== 'number' || now - m.at > MARKER_MS || now < m.at - 5000) return null;
    return { pid: Number(m.pid) || 0, at: m.at, dropped: Array.isArray(m.dropped) ? m.dropped.map(String) : [] };
  } catch { return null; }
}

export type Plan =
  | { relaunch: true; bundle: string; env: Record<string, string>; dropped: string[]; background: boolean }
  | { relaunch: false; why: 'clean' | 'not-packaged' | 'not-macos' | 'offscreen' | 'test-run' | 'no-bundle' | 'loop' };

/**
 * Whether this start relaunches clean. `marker` is the relaunching app's
 * marker when this start is its relaunch: one that still carries a pane's
 * variables (they came back from somewhere else, launchctl setenv) stays,
 * and the window's note says why its answers are off.
 */
export function relaunchPlan(o: { env: Env; packaged: boolean; platform: string; execPath: string; marker: Marker | null }): Plan {
  const { env } = o;
  if (!paneVars(env).length) return { relaunch: false, why: 'clean' };
  if (!o.packaged) return { relaunch: false, why: 'not-packaged' };
  if (o.platform !== 'darwin') return { relaunch: false, why: 'not-macos' };
  if (!testRelaunch(env)) {
    if (env.RAVENRY_OFFSCREEN === '1') return { relaunch: false, why: 'offscreen' };
    // A test's data folder or hub label: a test run, which decides what its app is.
    if (env.RAVENRY_DESKTOP_DATA || env.RAVENRY_SERVICE_LABEL) return { relaunch: false, why: 'test-run' };
  }
  if (o.marker) return { relaunch: false, why: 'loop' };
  const bundle = bundleOf(o.execPath);
  if (!bundle) return { relaunch: false, why: 'no-bundle' };
  // A test's relaunch stays in the background: it never takes the focus from the person.
  return { relaunch: true, bundle, ...cleanEnv(env), background: testRelaunch(env) && env[TEST_FLAG] !== 'foreground' };
}

/**
 * The helper that starts the new app: /bin/sh with these arguments, detached,
 * with the clean environment. It waits (up to 10 s) until this process is
 * gone, so the new app never meets it at the single-instance lock, then
 * asks LaunchServices for a new instance of the bundle, with no arguments.
 * A failed open is said in app.log. `background` (a test's) adds -g.
 */
export function helperArgs(pid: number, bundle: string, log: string, background = false): string[] {
  const script = [
    'i=0',
    'while [ "$i" -lt 200 ]; do',
    '  s=$(/bin/ps -o stat= -p "$1" 2>/dev/null) || break',
    '  case "$s" in Z*) break ;; esac',
    '  /bin/sleep 0.05; i=$((i + 1))',
    'done',
    `/usr/bin/open -n${background ? ' -g' : ''} -a "$2" || echo "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ) launch: relaunching clean failed: open -a $2 said no" >> "$3"`,
  ].join('\n');
  return ['-c', script, 'ravenry-relaunch', String(pid), bundle, log];
}
