// What the app takes from whoever launches it. Any program of the user's
// can start the app with an environment and arguments of its choosing
// (`env -i X=... open -a Ravenry`, or its executable run directly), and an
// app outside every pane acts as the person (PROTOCOL.md section 4, Who
// acts as the person). So a release build, the one people install, takes
// no test hook from its launch: no module to load (RAVENRY_DRIVER), no
// program to run in place of its own (RAVENRYD, RAVENRY_LAUNCHCTL, the
// hub's stand-ins), no text or file a test feeds the window, and no
// debugging port or inspector. Settings that only say where things are
// (data, runtime and state folders, the hub's address, a test's launchd
// label) or how the window looks stay: they move what the app works on,
// never who answers for the person.
//
// The gate is a build-time constant, RAVENRY_TEST_HOOKS (build.mjs):
// false in what scripts/pack.mjs packs for release, true in a development
// build and in the test twin pack.mjs makes beside the release
// (release-test/), which the tools that drive the window run. With it
// false, the code that loads a driver is not in the app at all.
//
// No Electron here, so tests import it.

declare const RAVENRY_TEST_HOOKS: boolean | undefined;

/** True only in a development or test build; never in a release (build.mjs defines it). */
export const TEST_HOOKS: boolean = typeof RAVENRY_TEST_HOOKS === 'boolean' && RAVENRY_TEST_HOOKS;

/**
 * Variables only tests and development set, each a way to run code in or
 * through the app, or to feed its window: a release build removes them
 * from its environment before anything reads it, so neither the app nor
 * what it starts (the daemon, the hub service, the npm switch script) sees
 * them.
 *
 *   RAVENRY_DRIVER          a module the main process loads (tools/driver.cjs)
 *   RAVENRY_DRIVE(_LOG)     the driver's plan and log
 *   RAVENRYD                a ravenryd to start in place of the app's own
 *   RAVENRY_LAUNCHCTL       a program run in place of /bin/launchctl
 *   RAVENRY_NEW_SHELL       the program a new shell runs
 *   RAVENRY_TEST_CLIPBOARD  what a paste reads, offscreen
 *   RAVENRY_SETTINGS_IMPORT the theme file an import reads, offscreen
 *   RAVENRY_TEST_FOLDER     the folder Choose another folder picks, offscreen
 *   MC_*, FAKE_*, STUB_*, CMUX_BIN, TEST_RAVENRY
 *                           the hub's stand-ins (programs it runs in place
 *                           of ps, lsof, open, cmux), which the app passes
 *                           to a test label's service
 *   NODE_OPTIONS, NODE_PATH Node's options and module folders: the fuses
 *                           turn NODE_OPTIONS off in the executable itself;
 *                           this keeps both from the hub script the app runs
 */
export const CONTROL_VARS = ['RAVENRY_DRIVER', 'RAVENRY_DRIVE', 'RAVENRY_DRIVE_LOG', 'RAVENRYD', 'RAVENRY_LAUNCHCTL', 'RAVENRY_NEW_SHELL', 'RAVENRY_TEST_CLIPBOARD', 'RAVENRY_SETTINGS_IMPORT', 'RAVENRY_TEST_FOLDER', 'CMUX_BIN', 'TEST_RAVENRY', 'NODE_OPTIONS', 'NODE_PATH'] as const;
const CONTROL_PREFIXES = ['MC_', 'FAKE_', 'STUB_'];

export function isControlVar(k: string): boolean {
  return (CONTROL_VARS as readonly string[]).includes(k) || CONTROL_PREFIXES.some((p) => k.startsWith(p));
}

/**
 * Command-line switches that open the app to another program: a DevTools
 * port or pipe into the window and the main process, Node's inspector,
 * and Chromium's switches that run a program of the caller's in place of
 * one of the app's own processes. A release build started with one quits
 * before it opens a window or reaches a daemon. (The inspector and
 * NODE_OPTIONS are also off in the executable itself: the fuses in
 * electron-builder.config.mjs.)
 */
export const CONTROL_SWITCHES = [
  'remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'remote-debugging-io-pipes',
  'inspect', 'inspect-brk', 'inspect-port', 'inspect-brk-node', 'inspect-publish-uid', 'debug', 'debug-brk', 'debug-port',
  'js-flags', 'renderer-cmd-prefix', 'utility-cmd-prefix', 'gpu-launcher', 'browser-subprocess-path',
] as const;

/**
 * The control switches in a command line (names, sorted). Chromium reads
 * `--name`, `--name=value` and `-name` alike, up to a bare `--`.
 */
export function controlSwitches(argv: readonly string[]): string[] {
  const found = new Set<string>();
  for (const a of argv.slice(1)) {
    if (a === '--') break;
    const m = /^--?([A-Za-z0-9][A-Za-z0-9-]*)(?:=|$)/.exec(a);
    if (m && (CONTROL_SWITCHES as readonly string[]).includes(m[1].toLowerCase())) found.add(m[1].toLowerCase());
  }
  return [...found].sort();
}

export interface Gate {
  /** True: a development or test build, which keeps every hook. */
  hooks: boolean;
  /** The control variables this launch carried and the release removed (names, sorted). */
  ignored: string[];
  /** The control switches this launch carried (names, sorted); a release quits on them. */
  switches: string[];
}

/**
 * Applies the gate to this process's environment: in a release (`hooks`
 * false), every control variable is removed from `env` in place. Returns
 * what it found. A test build changes nothing.
 */
export function applyGate(env: Record<string, string | undefined>, argv: readonly string[], hooks: boolean = TEST_HOOKS): Gate {
  if (hooks) return { hooks, ignored: [], switches: [] };
  const ignored = Object.keys(env).filter((k) => env[k] !== undefined && isControlVar(k)).sort();
  for (const k of ignored) delete env[k];
  return { hooks, ignored, switches: controlSwitches(argv) };
}
