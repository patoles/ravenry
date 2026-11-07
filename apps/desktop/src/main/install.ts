// What the packaged app puts on this machine besides its window: a copy of
// its ravenryd and its hub per version, and the hub as a user service. No
// Electron here, so tests import it.
//
// Versions. The app ships ravenryd and the hub in its resources, and on
// launch copies them to <data>/versions/<version>/ (with remote/, the
// builds the hub installs on other machines). Daemons and the hub run
// from that copy, never from inside the app, so replacing the app (an
// update, or an AppImage that unmounts when it quits) never pulls a running
// binary out from under them. <data>/bin/ravenryd always links to the
// newest copy: a stable path for the hub and for hooks; <data>/bin/ravenry
// links to it too (one binary that picks its mode by name: ravenry is what
// people and agents type). A version folder is
// removed once nothing runs from it (no daemon of that version has a socket,
// and the service does not name it).
//
// The hub service. The hub runs always on, under launchd on macOS
// (~/Library/LaunchAgents/dev.ravenry.hub.plist) and systemd on Linux
// (~/.config/systemd/user/dev.ravenry.hub.service), as the app's own executable
// with ELECTRON_RUN_AS_NODE=1: users install no Node. An AppImage's hub runs
// a copy of its Electron runtime in the version folder instead (see
// runtimeSource). It is written on first
// launch, rewritten when it would change (a new version, a moved app), and
// then restarted. Restarting the hub never ends a session: sessions live in
// ravenryd, which runs in its own process session (serve --detach), and the
// service is told to leave it alone (AbandonProcessGroup, KillMode=process).
// When a board already answers and no service of ours exists (the user runs
// `ravenry` from npm, or a board of their own), nothing is installed; the
// npm board is offered the switch first (npmswitch.ts), and its way back
// takes the service out again (removeService).
//
// The home folder is HOME (os.homedir), so a test's throwaway HOME gets the
// service file, never the user's own.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The release check (tools/release-check.mjs) runs the packaged app with a
// launchd label of its own, `dev.ravenry.hub.test-<random>`, so the real
// launchd is used and dev.ravenry.hub is never touched. No other label is
// taken from the environment.
export const TEST_LABEL = /^dev\.ravenry\.hub\.test-[a-z0-9]{4,32}$/;
const testLabel = (v: string | undefined) => (v && TEST_LABEL.test(v) ? v : null);
export const SERVICE_LABEL = testLabel(process.env.RAVENRY_SERVICE_LABEL) || 'dev.ravenry.hub';
export const UNIT_NAME = `${SERVICE_LABEL}.service`;

type Env = Record<string, string | undefined>;

/** What the packaging wrote beside the app: resources/build.json. */
export interface BuildInfo { version: string; commit?: string; builtAt?: string; id: string }

export function readBuildInfo(resources: string): BuildInfo | null {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(resources, 'build.json'), 'utf8')) as BuildInfo;
    return b && typeof b.version === 'string' && typeof b.id === 'string' ? b : null;
  } catch { return null; }
}

/**
 * Where the app keeps its versions: RAVENRY_DESKTOP_DATA, else
 * ~/Library/Application Support/Ravenry on macOS and
 * $XDG_DATA_HOME/ravenry (~/.local/share/ravenry) on Linux.
 */
export function dataRoot(env: Env = process.env, platform: string = process.platform, home: string = os.homedir()): string {
  if (env.RAVENRY_DESKTOP_DATA) return env.RAVENRY_DESKTOP_DATA;
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Ravenry');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'ravenry');
}

export interface Staged {
  version: string;
  dir: string;
  /** This version's ravenryd. */
  ravenryd: string;
  /** <data>/bin/ravenryd, the link to the newest version's ravenryd. */
  link: string;
  /** <data>/bin/ravenry, the same binary by the name people type. */
  cli: string;
  /** The hub's server, to run with node. */
  hubEntry: string;
  /** The build staged there (build.json's id): a rebuilt package of the same version is another build. */
  build?: string;
}

const exe = (platform: string) => (platform === 'win32' ? 'ravenryd.exe' : 'ravenryd');

/**
 * Copies the app's ravenryd and hub to <root>/versions/<version>, unless that
 * build is there already, and points <root>/bin/ravenryd at it.
 */
export function stageVersion(opts: { resources: string; root: string; build: BuildInfo; platform?: string }): Staged {
  const { resources, root, build } = opts;
  const name = exe(opts.platform || process.platform);
  if (!/^[0-9A-Za-z.+-]+$/.test(build.version)) throw new Error(`a version that is not a folder name: ${build.version}`);
  const versions = path.join(root, 'versions');
  const dir = path.join(versions, build.version);
  const out: Staged = {
    version: build.version,
    dir,
    ravenryd: path.join(dir, name),
    link: path.join(root, 'bin', name),
    cli: path.join(root, 'bin', name.replace('ravenryd', 'ravenry')),
    hubEntry: path.join(dir, 'hub', 'server', 'index.mjs'),
    build: build.id,
  };
  const marker = path.join(dir, '.build.json');
  let have: BuildInfo | null = null;
  try { have = JSON.parse(fs.readFileSync(marker, 'utf8')) as BuildInfo; } catch { /* not staged */ }
  if (!have || have.id !== build.id || !fs.existsSync(out.ravenryd) || !fs.existsSync(out.hubEntry)) {
    fs.mkdirSync(versions, { recursive: true, mode: 0o700 });
    const tmp = path.join(versions, `.${build.version}.${process.pid}.tmp`);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { mode: 0o755 });
    fs.copyFileSync(path.join(resources, name), path.join(tmp, name));
    fs.chmodSync(path.join(tmp, name), 0o755);
    fs.cpSync(path.join(resources, 'hub'), path.join(tmp, 'hub'), { recursive: true });
    // The builds the hub installs on other machines over ssh
    // (hub/server/remoteinstall.mjs finds them beside this ravenryd).
    if (fs.existsSync(path.join(resources, 'remote', 'builds.json'))) fs.cpSync(path.join(resources, 'remote'), path.join(tmp, 'remote'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.build.json'), JSON.stringify(build) + '\n');
    // Same version, other build (a rebuilt package): move the old copy
    // aside first. A daemon running from it keeps its file open.
    if (fs.existsSync(dir)) {
      const old = path.join(versions, `.${build.version}.${process.pid}.old`);
      fs.rmSync(old, { recursive: true, force: true });
      fs.renameSync(dir, old);
      fs.renameSync(tmp, dir);
      fs.rmSync(old, { recursive: true, force: true });
    } else {
      fs.renameSync(tmp, dir);
    }
  }
  // The stable links, each replaced in one rename.
  fs.mkdirSync(path.dirname(out.link), { recursive: true, mode: 0o700 });
  const target = path.relative(path.dirname(out.link), out.ravenryd);
  for (const link of [out.link, out.cli]) {
    let current: string | null = null;
    try { current = fs.readlinkSync(link); } catch { /* none yet */ }
    if (current === target) continue;
    const tmpLink = `${link}.${process.pid}.tmp`;
    fs.rmSync(tmpLink, { force: true });
    fs.symlinkSync(target, tmpLink);
    fs.renameSync(tmpLink, link);
  }
  return out;
}

/**
 * Removes version folders nothing runs from: not `keep`, no daemon socket
 * of that version in the runtime folder, and not named by the service file.
 * Returns the versions removed.
 */
// `inUse`: text that names what runs or will run from a version folder:
// the command lines of the running processes (a ravenryd or hub of that
// version, whatever its socket says) and the assistants' hook settings
// (a hook that names a version runs it at the next event). A version
// folder any of them names is kept.
export function pruneVersions(root: string, keep: string, runningVersions: string[], serviceText: string | null, inUse: string[] = []): string[] {
  const versions = path.join(root, 'versions');
  let names: string[];
  try { names = fs.readdirSync(versions); } catch { return []; }
  const removed: string[] = [];
  // The folder the hooks run (hub/server/hookinstall.mjs pointCurrent).
  const current = real(path.join(root, 'current'));
  for (const v of names) {
    if (v.startsWith('.')) {
      // A copy left half done by a launch that died: older than a minute.
      try { if (Date.now() - fs.statSync(path.join(versions, v)).mtimeMs > 60000) fs.rmSync(path.join(versions, v), { recursive: true, force: true }); } catch { /* gone */ }
      continue;
    }
    if (v === keep || runningVersions.includes(v)) continue;
    if (serviceText && serviceText.includes(path.join(versions, v) + path.sep)) continue;
    const dir = path.join(versions, v) + path.sep;
    if (inUse.some((t) => t && t.includes(dir))) continue;
    if (current && current === real(path.join(versions, v))) continue;
    if (isHookStubs(path.join(versions, v))) continue;
    try {
      const hooks = hookScripts(path.join(versions, v));
      fs.rmSync(path.join(versions, v), { recursive: true, force: true });
      writeHookStubs(path.join(versions, v), hooks);
      removed.push(v);
    } catch { /* in use: next time */ }
  }
  return removed;
}

// A Claude Code or Codex session reads its hooks once, when it starts, so
// one started before an update goes on calling the hook scripts of the
// version folder it saw (2026-11-07: "hook error" at every turn once that
// folder was gone). Hooks now name <data>/current (hub/server/hookinstall.mjs),
// and a removed version folder keeps, at the same paths, one small script
// per hook that runs current's: no hook any running session can call ever
// breaks. A folder of stubs is marked and never removed (a few hundred bytes).
const STUB_MARK = 'REMOVED';
const real = (p: string): string | null => { try { return fs.realpathSync(p); } catch { return null; } };
function isHookStubs(dir: string): boolean { return fs.existsSync(path.join(dir, STUB_MARK)); }
function hookScripts(dir: string): string[] {
  try { return fs.readdirSync(path.join(dir, 'hub', 'hooks')).filter((f) => /\.m?js$/.test(f)); } catch { return []; }
}
export function writeHookStubs(dir: string, scripts: string[]): void {
  if (!scripts.length) return;
  const hooks = path.join(dir, 'hub', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(dir, STUB_MARK), 'This version of Ravenry was removed by an update. Its hook scripts stay, each running the current version\'s, for sessions started before the update.\n');
  for (const f of scripts) {
    fs.writeFileSync(path.join(hooks, f), `// This version of Ravenry was removed by an update; a session started
// before it still calls this hook. It runs the current version's.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = fileURLToPath(import.meta.url);
const data = path.resolve(path.dirname(here), '..', '..', '..', '..');
try { await import(pathToFileURL(path.join(data, 'current', 'hub', 'hooks', path.basename(here))).href); } catch { process.exit(0); }
`);
  }
}

// ------------------------------------------------------------- the service

export interface ServiceSpec {
  /** The app's executable, run with ELECTRON_RUN_AS_NODE=1 as node. */
  exe: string;
  /** The hub's server file. */
  hubEntry: string;
  /** The hub's environment, without ELECTRON_RUN_AS_NODE (always added). */
  env: Record<string, string>;
  /** macOS: where launchd writes the hub's output. */
  logDir: string;
}

/**
 * Where to copy an Electron runtime from for the hub, or null when the
 * service can run the app's own executable. An AppImage runs from a folder
 * it mounts only while it runs, and its AppRun adds --no-sandbox wherever
 * unprivileged user namespaces are off (Ubuntu 24.04 by default), which the
 * executable run as Node refuses ("bad option"). So the hub of an AppImage
 * runs a copy of the runtime in its version folder (stageRuntime), started
 * directly, with no AppRun.
 */
export function runtimeSource(execPath: string, env: Env = process.env, platform: string = process.platform): string | null {
  return platform === 'linux' && env.APPIMAGE ? path.dirname(execPath) : null;
}

// What the hub needs of an Electron runtime on Linux to run as Node: the
// executable, the libraries it links and the data V8 and ICU read. Not the
// window's resources (app.asar, the hub is copied apart), locales, GPU
// libraries or the sandbox helper.
const RUNTIME_SKIP = new Set(['resources', 'locales', 'usr', 'chrome-sandbox', 'AppRun', '.DirIcon', 'LICENSES.chromium.html']);

/**
 * Copies the Electron runtime at `from` (an AppImage's mounted folder) into
 * <version folder>/runtime once per build. Returns the executable to run.
 */
export async function stageRuntime(opts: { from: string; staged: Staged; build: BuildInfo; exeName: string }): Promise<string> {
  const dst = path.join(opts.staged.dir, 'runtime');
  const exe = path.join(dst, opts.exeName);
  const marker = path.join(dst, '.build.json');
  try {
    if ((JSON.parse(fs.readFileSync(marker, 'utf8')) as BuildInfo).id === opts.build.id && fs.existsSync(exe)) return exe;
  } catch { /* not copied yet */ }
  const tmp = `${dst}.${process.pid}.tmp`;
  await fs.promises.rm(tmp, { recursive: true, force: true });
  await fs.promises.mkdir(tmp, { recursive: true });
  for (const name of await fs.promises.readdir(opts.from)) {
    if (RUNTIME_SKIP.has(name) || name.endsWith('.desktop') || name.endsWith('.png') || name.endsWith('.svg')) continue;
    await fs.promises.cp(path.join(opts.from, name), path.join(tmp, name), { recursive: true });
  }
  await fs.promises.writeFile(path.join(tmp, '.build.json'), JSON.stringify(opts.build) + '\n');
  const old = `${dst}.${process.pid}.old`;
  if (fs.existsSync(dst)) await fs.promises.rename(dst, old);
  await fs.promises.rename(tmp, dst);
  await fs.promises.rm(old, { recursive: true, force: true });
  return exe;
}

/** True when this copy updates itself: macOS, and Linux as an AppImage (a .deb does not). */
export function selfUpdating(env: Env = process.env, platform: string = process.platform): boolean {
  return platform === 'darwin' || (platform === 'linux' && !!env.APPIMAGE);
}

/**
 * The hub's PATH. launchd and systemd start jobs with a bare PATH, and the
 * hub runs git, claude and codex: the usual folders for them, then the
 * app's own PATH (full when it was started from a terminal).
 */
export function servicePath(env: Env = process.env, platform: string = process.platform, home: string = os.homedir()): string {
  const usual = [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : ['/usr/local/bin']),
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  ];
  const tmp = os.tmpdir();
  // Never a per-session shim under the temp folder: it is gone after a restart.
  const own = String(env.PATH || '').split(':').filter((d) => d && path.isAbsolute(d) && !d.startsWith(tmp) && !d.startsWith('/tmp/') && !d.includes('/cmux-cli-shims/'));
  return [...new Set([...own, ...usual])].join(':');
}

/** Variables a test (or a developer) set for the app that the hub should share. */
const SHARED = ['RAVENRY_HOME', 'RAVENRY_RUNTIME_DIR', 'RAVENRY_STATE_DIR', 'PORT'];

/**
 * The service for this app: the executable to run as Node (the app's own,
 * or the runtime copied for an AppImage), the staged hub, and the hub's
 * environment.
 */
export function serviceSpec(opts: { execPath: string; staged: Staged; env?: Env; platform?: string; home?: string }): ServiceSpec {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const home = opts.home || os.homedir();
  const hubEnv: Record<string, string> = {
    PATH: servicePath(env, platform, home),
    RAVENRY_DAEMON_BIN: opts.staged.link,
    // The board of the app's own terminal: sessions in ravenryd panes.
    RAVENRY_TERMINAL: 'ravenry',
    RAVENRY_HUB_SERVICE: '1',
    RAVENRY_APP_VERSION: opts.staged.version,
  };
  // The build, so a rebuilt package of the same version changes the
  // service's file: ensureService then rewrites it and restarts the hub,
  // which would otherwise keep serving the old build's code from memory
  // while versions/<version> holds the new one.
  if (opts.staged.build) hubEnv.RAVENRY_APP_BUILD = opts.staged.build;
  for (const k of SHARED) if (env[k]) hubEnv[k] = env[k]!;
  // Under a test label (the release check), the hub gets the check's
  // throwaway HOME and its stand-ins (ps, lsof, cmux, the open command),
  // which launchd would not pass on.
  if (SERVICE_LABEL !== 'dev.ravenry.hub') {
    for (const [k, v] of Object.entries(env)) if (v && (k === 'HOME' || /^(MC_|FAKE_|STUB_|CMUX_BIN$|RAVENRY_PHONE_PORT$|TEST_RAVENRY$)/.test(k))) hubEnv[k] = v;
  }
  return {
    exe: opts.execPath,
    hubEntry: opts.staged.hubEntry,
    env: hubEnv,
    logDir: platform === 'darwin' ? path.join(home, 'Library', 'Logs', 'Ravenry') : path.join(home, '.local', 'state', 'ravenry'),
  };
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The launchd agent. ProcessType is Standard, not Background: macOS slows
 * a Background job (CPU, disk, timers) on a busy Mac, and the hub ran 20 to
 * 40 times slower than in a terminal (its first tick 4.7 s, its first
 * process list 9 s after start; 2026-11-07), and a daemon it starts hands
 * that on to every pane, the assistants' sessions included.
 */
export function plistText(spec: ServiceSpec): string {
  const env = { ELECTRON_RUN_AS_NODE: '1', ...spec.env };
  const envXml = Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Ravenry's hub, written by the Ravenry app. The app rewrites it when it updates. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(spec.exe)}</string>
    <string>${xml(spec.hubEntry)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(path.dirname(path.dirname(spec.hubEntry)))}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Standard</string>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(path.join(spec.logDir, 'hub.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(spec.logDir, 'hub.log'))}</string>
</dict>
</plist>
`;
}

// systemd splits ExecStart on spaces and reads % and $ itself.
const sdQuote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;

/** The systemd user unit. */
export function unitText(spec: ServiceSpec): string {
  const env = { ELECTRON_RUN_AS_NODE: '1', ...spec.env };
  return `# Ravenry's hub, written by the Ravenry app. The app rewrites it when it updates.
[Unit]
Description=Ravenry hub (the board's server)
After=network.target

[Service]
Type=simple
ExecStart=${sdQuote(spec.exe)} ${sdQuote(spec.hubEntry)}
WorkingDirectory=${path.dirname(path.dirname(spec.hubEntry)).replace(/%/g, '%%')}
${Object.entries(env).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`).join('\n')}
Restart=on-failure
RestartSec=30
# Only the hub: ravenryd, which it may start, keeps running (and its
# sessions with it) when the hub stops or restarts.
KillMode=process

[Install]
WantedBy=default.target
`;
}

/** Where the service file goes. */
export function serviceFile(platform: string = process.platform, home: string = os.homedir(), env: Env = process.env): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd', 'user', UNIT_NAME);
}

export type ServiceMode = 'install' | 'dry-run' | 'off';

/**
 * install: write the service and (re)start it. dry-run: write the file and
 * say which commands would run, running none. off: nothing.
 * RAVENRY_SERVICE picks it; by default a packaged app installs and a
 * development run does nothing.
 */
export function serviceMode(env: Env = process.env, packaged: boolean): ServiceMode {
  const v = env.RAVENRY_SERVICE;
  if (v === 'install' || v === 'dry-run' || v === 'off') return v;
  return packaged && env.RAVENRY_OFFSCREEN !== '1' ? 'install' : 'off';
}

export type Runner = (cmd: string, args: string[]) => { status: number | null; out: string };

/** launchctl, or the stand-in a test names (RAVENRY_LAUNCHCTL), so a test never loads a job into the real launchd. */
export function launchctlBin(env: Env = process.env): string {
  return env.RAVENRY_LAUNCHCTL || '/bin/launchctl';
}

export interface ServiceResult {
  state: 'off' | 'kept' | 'installed' | 'updated' | 'skipped' | 'failed';
  file?: string;
  why?: string;
  /** The commands run (install) or that would run (dry-run). */
  commands: string[][];
}

/**
 * Makes the service match `spec`: writes it when it is missing or differs,
 * and starts or restarts the hub. A running service that already matches is
 * left alone. `boardAnswers` says whether a board already serves (only
 * asked when no service of ours exists).
 */
export async function ensureService(opts: {
  mode: ServiceMode;
  spec: ServiceSpec;
  run: Runner;
  boardAnswers: () => Promise<boolean>;
  platform?: string;
  home?: string;
  uid?: number;
  env?: Env;
  /** Restart a running service even when its file is current (after the switch from the npm board, whose board held the port). */
  restart?: boolean;
  /** Waits (tests pass one that does not sleep). */
  wait?: (ms: number) => Promise<void>;
  /**
   * Whether the hub the service now runs answers (any HTTP answer: a hub
   * waiting for macOS's privacy answer says 503 and is alive). Asked after
   * the service is written and loaded; no answer, and the file that ran
   * before is put back and loaded, and the result says so. On 2026-11-07
   * the new hub listened and answered nothing, and the old version was
   * removed with nothing to go back to.
   */
  answers?: () => Promise<boolean>;
}): Promise<ServiceResult> {
  const wait = opts.wait || ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const platform = opts.platform || process.platform;
  const home = opts.home || os.homedir();
  const uid = opts.uid ?? (process.getuid ? process.getuid() : 0);
  const commands: string[][] = [];
  if (opts.mode === 'off') return { state: 'off', commands };
  if (platform !== 'darwin' && platform !== 'linux') return { state: 'off', why: `no service on ${platform} yet`, commands };
  const file = serviceFile(platform, home, opts.env || process.env);
  const text = platform === 'darwin' ? plistText(opts.spec) : unitText(opts.spec);
  let existing: string | null = null;
  try { existing = fs.readFileSync(file, 'utf8'); } catch { /* none */ }
  const dry = opts.mode === 'dry-run';
  const run = (cmd: string, args: string[]) => {
    commands.push([cmd, ...args]);
    return dry ? { status: 0, out: '' } : opts.run(cmd, args);
  };
  const domain = `gui/${uid}`;
  const lctl = launchctlBin(opts.env || process.env);
  const loaded = () => {
    if (dry) return false;
    if (platform === 'darwin') return opts.run(lctl, ['print', `${domain}/${SERVICE_LABEL}`]).status === 0;
    return opts.run('systemctl', ['--user', 'is-active', '--quiet', UNIT_NAME]).status === 0;
  };

  if (existing === null && (await opts.boardAnswers())) {
    return { state: 'skipped', file, why: 'a board is already running, so the app uses it and installs no service', commands };
  }
  if (existing === text && loaded()) {
    if (!opts.restart) return { state: 'kept', file, commands };
    const r = platform === 'darwin' ? run(lctl, ['kickstart', '-k', `${domain}/${SERVICE_LABEL}`]) : run('systemctl', ['--user', 'restart', UNIT_NAME]);
    return r.status === 0 ? { state: 'kept', file, why: 'restarted', commands } : { state: 'failed', file, why: r.out || 'the service manager refused the restart', commands };
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (platform === 'darwin') fs.mkdirSync(opts.spec.logDir, { recursive: true });
  const put = (t: string) => {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, t, { mode: 0o644 });
    fs.renameSync(tmp, file);
  };
  put(text);

  let ok: boolean;
  let detail = '';
  if (platform === 'darwin') {
    // bootout stops the old hub (SIGTERM, it exits cleanly); its daemons
    // are in their own process session and keep running. launchd lets go
    // of the job a moment after bootout returns, and a bootstrap before
    // then fails ("Bootstrap failed: 5: Input/output error") and leaves no
    // service at all: on 2026-11-07 that left the hub down. So the app
    // waits until the job is gone, bootstraps (again, a few times, if
    // launchd still says no), and checks the service is loaded. When it
    // is not, the file that ran before is put back and loaded, and the
    // result says so.
    const up = async (): Promise<{ ok: boolean; out: string }> => {
      if (dry) { run(lctl, ['bootstrap', domain, file]); return { ok: true, out: '' }; }
      let out = '';
      for (let i = 0; i < 5; i++) {
        if (i) await wait(400 * i);
        if (loaded()) return { ok: true, out };
        const r = run(lctl, ['bootstrap', domain, file]);
        out = r.out;
        if (r.status === 0 && loaded()) return { ok: true, out };
      }
      return { ok: loaded(), out };
    };
    run(lctl, ['bootout', `${domain}/${SERVICE_LABEL}`]);
    for (let i = 0; !dry && i < 50 && loaded(); i++) await wait(200);
    const r = await up();
    ok = r.ok;
    detail = r.out;
    let why = detail || 'launchd did not load it';
    if (ok && !dry && opts.answers && !(await opts.answers())) { ok = false; why = 'the new hub did not answer'; }
    if (!ok && existing !== null) {
      if (!dry) {
        run(lctl, ['bootout', `${domain}/${SERVICE_LABEL}`]);
        for (let i = 0; i < 50 && loaded(); i++) await wait(200);
      }
      put(existing);
      const back = await up();
      detail = `${why}; ${back.ok ? 'the service that ran before is loaded again' : 'the service that ran before did not load either'}`;
    } else if (!ok) detail = why;
  } else {
    const r1 = run('systemctl', ['--user', 'daemon-reload']);
    const r2 = run('systemctl', ['--user', 'enable', UNIT_NAME]);
    const r3 = run('systemctl', ['--user', 'restart', UNIT_NAME]);
    ok = r1.status === 0 && r2.status === 0 && r3.status === 0;
    detail = [r1, r2, r3].map((r) => r.out).join('').trim();
    if (ok && !dry && opts.answers && !(await opts.answers())) {
      ok = false;
      detail = 'the new hub did not answer';
      if (existing !== null) {
        put(existing);
        const b1 = run('systemctl', ['--user', 'daemon-reload']);
        const b2 = run('systemctl', ['--user', 'restart', UNIT_NAME]);
        detail += b1.status === 0 && b2.status === 0 ? '; the service that ran before runs again' : '; the service that ran before did not start either';
      }
    }
  }
  if (!ok) return { state: 'failed', file, why: detail || 'the service manager refused it', commands };
  return { state: existing === null ? 'installed' : 'updated', file, commands };
}

/**
 * Takes the hub service out: stopped (the hub exits; its daemons, in their
 * own process session, keep their sessions) and its file deleted, so it no
 * longer starts at login. The way back to the npm board does this first.
 */
export function removeService(opts: { mode: ServiceMode; run: Runner; platform?: string; home?: string; uid?: number; env?: Env }): ServiceResult {
  const platform = opts.platform || process.platform;
  const home = opts.home || os.homedir();
  const uid = opts.uid ?? (process.getuid ? process.getuid() : 0);
  const env = opts.env || process.env;
  const commands: string[][] = [];
  if (opts.mode === 'off') return { state: 'off', commands };
  if (platform !== 'darwin' && platform !== 'linux') return { state: 'off', commands };
  const file = serviceFile(platform, home, env);
  const dry = opts.mode === 'dry-run';
  const run = (cmd: string, args: string[]) => { commands.push([cmd, ...args]); return dry ? { status: 0, out: '' } : opts.run(cmd, args); };
  if (platform === 'darwin') run(launchctlBin(env), ['bootout', `gui/${uid}/${SERVICE_LABEL}`]);
  else run('systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
  if (!dry) fs.rmSync(file, { force: true });
  if (platform === 'linux' && !dry) run('systemctl', ['--user', 'daemon-reload']);
  return { state: 'skipped', file, why: 'removed', commands };
}
