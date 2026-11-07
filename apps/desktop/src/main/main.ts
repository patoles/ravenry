// Ravenry's desktop app, the main process: one window with the board in a
// sidebar, real terminals in the middle and the session panel on the right.
// Terminals live in ravenryd, never here, so they outlive the window.
//
// Settings from the environment, for development and tests:
//   RAVENRYD               the ravenryd binary to start when none runs
//   RAVENRY_RUNTIME_DIR    where daemons' sockets are (PROTOCOL.md section 9)
//   RAVENRY_HUB_URL        the hub (else the running board's port)
//   RAVENRY_NEW_SHELL      the command a new plain shell runs ("zsh -f");
//                          default: the login shell
//   RAVENRY_DESKTOP_DATA   the app's data folder (default: Electron's userData)
//   RAVENRY_THEME          dark or light (default: the system's)
//   RAVENRY_OFFSCREEN=1    never show the window (tests and screenshots), and
//                          never open a browser, an editor or the clipboard:
//                          what would open is written to RAVENRY_OPEN_LOG
//   RAVENRY_DRIVER         a script that drives the window (tools/); a
//                          development or test build only (gate.ts)
//   RAVENRY_SERVICE        install, dry-run or off: the hub service
//                          (install.ts; default: install when packaged)
//   RAVENRY_UPDATES=0      never check for updates (updater.ts)
//   RAVENRY_LAUNCHCTL      a stand-in for /bin/launchctl (tests: the hub
//                          service and the npm board's login start)
//   RAVENRY_RELAUNCH_TEST=1 | foreground  tools/relaunch-check.mjs only: a start from a
//                          pane relaunches in a test run too (relaunch.ts)
//
// A release build takes none of the variables that run code in the app or
// feed its window (RAVENRYD, RAVENRY_DRIVER, RAVENRY_LAUNCHCTL,
// RAVENRY_NEW_SHELL, RAVENRY_TEST_CLIPBOARD, the hub's stand-ins: gate.ts
// lists them) and quits when started with a debugging switch.
//
// The home folder is HOME (os.homedir), so a test's throwaway HOME is used
// for everything the app reads there.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { listSockets, runtimeDir } from '@ravenry/client/node';
import { DaemonLink } from './daemon.ts';
import { HubFeed, hubAnswer, hubCall, hubGet, hubPost, hubUrl } from './hub.ts';
import type { HubStatus } from './hub.ts';
import { dataRoot, ensureService, updateAttempt, launchctlBin, pruneVersions, readBuildInfo, removeService, runtimeSource, serviceFile, serviceMode, serviceSpec, stageRuntime, stageVersion } from './install.ts';
import type { Staged } from './install.ts';
import { launchPlan, offerFor, runScript, scriptPath } from './npmswitch.ts';
import type { NpmDetect, Offer } from './npmswitch.ts';
import { findAssistants, findProjectFolders, shortPath, Store } from './local.ts';
import { Updates } from './updater.ts';
import { initSettings, openSettings } from './settings.ts';
import { helperArgs, MARKER, paneVars, readMarker, relaunchPlan } from './relaunch.ts';
import { applyGate } from './gate.ts';

// build.mjs defines it: false in a release build, so what it guards is not
// in the app at all (gate.ts).
declare const RAVENRY_TEST_HOOKS: boolean;

// The environment as launched, then the gate (gate.ts): a release build
// drops every test hook from process.env before anything reads it. The
// relaunch from a pane (relaunch.ts) judges the launch as it came, so its
// log still names everything it dropped.
const LAUNCH_ENV: Record<string, string | undefined> = { ...process.env };
const GATE = applyGate(process.env, process.argv, RAVENRY_TEST_HOOKS);

const APP_ROOT = path.resolve(__dirname, '..');
const OFFSCREEN = process.env.RAVENRY_OFFSCREEN === '1';
const isMac = process.platform === 'darwin';

app.setName('Ravenry');
if (process.env.RAVENRY_DESKTOP_DATA) app.setPath('userData', process.env.RAVENRY_DESKTOP_DATA);
if (process.env.RAVENRY_THEME === 'dark' || process.env.RAVENRY_THEME === 'light') nativeTheme.themeSource = process.env.RAVENRY_THEME;

// Started with a pane's variables (an agent in a pane opened the app):
// relaunched clean, as the Dock starts it, before anything else
// (relaunch.ts). This start exits without a window or a daemon.
const leaving = relaunchClean() || refuseSwitches();
if (!leaving && GATE.ignored.length) appLog(`launch: a release build takes no test hooks from its environment: ignored ${GATE.ignored.join(', ')}`);
if (RAVENRY_TEST_HOOKS && !leaving && app.isPackaged) appLog('launch: a test build, its test hooks on (tools only: never install it)');

// Two windows on one set of tabs would fight over them.
if (!leaving && !OFFSCREEN && !app.requestSingleInstanceLock()) app.exit(0);

const daemon = new DaemonLink(APP_ROOT);
let store: Store;
let win: BrowserWindow | null = null;
let feed: HubFeed | null = null;
const updates = new Updates(process.resourcesPath, () => menu());

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

// The ravenryd the first-launch hook setup writes into Claude Code's and
// Codex's settings: the packaged app's <data>/bin/ravenryd, which always
// links to the newest version, else (development, tests) RAVENRYD.
function hookBin(): string | null {
  const p = app.isPackaged ? path.join(dataRoot(), 'bin', 'ravenryd') : process.env.RAVENRYD || '';
  return p && path.isAbsolute(p) && fs.existsSync(p) ? p : null;
}

function relaunchClean(): boolean {
  // The relaunching app's marker, read once: the loop guard and the log line.
  const file = path.join(app.getPath('userData'), MARKER);
  const marker = app.isPackaged ? readMarker(file) : null;
  if (app.isPackaged) { try { fs.rmSync(file, { force: true }); } catch { /* none */ } }
  const plan = relaunchPlan({ env: LAUNCH_ENV, packaged: app.isPackaged, platform: process.platform, execPath: process.execPath, marker });
  if (marker && !plan.relaunch && plan.why === 'clean') {
    appLog(`launch: relaunched clean (pid ${marker.pid} was started with a pane's variables); dropped: ${marker.dropped.join(', ') || 'nothing'}`);
  } else if (!plan.relaunch && plan.why === 'loop') {
    appLog(`launch: still started with ${paneVars(LAUNCH_ENV).join(', ')} after relaunching clean; staying, and the window says its answers are off`);
  }
  if (!plan.relaunch) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), dropped: plan.dropped }));
    const logDir = path.join(plan.env.HOME || os.homedir(), 'Library', 'Logs', 'Ravenry');
    fs.mkdirSync(logDir, { recursive: true });
    spawn('/bin/sh', helperArgs(process.pid, plan.bundle, path.join(logDir, 'app.log'), plan.background), { env: plan.env, cwd: '/', detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    appLog(`launch: started with ${paneVars(LAUNCH_ENV).join(', ')} and could not relaunch clean: ${(e as Error).message || e}`);
    try { fs.rmSync(file, { force: true }); } catch { /* none */ }
    return false;
  }
  app.exit(0);
  return true;
}

// A release build started with a debugging switch (gate.ts) quits before it
// opens a window or reaches a daemon.
function refuseSwitches(): boolean {
  if (!GATE.switches.length) return false;
  appLog(`launch: started with ${GATE.switches.map((s) => `--${s}`).join(', ')}, which a release build refuses: quitting`);
  app.exit(1);
  return true;
}

function newShellCommand(): string[] | null {
  const v = (process.env.RAVENRY_NEW_SHELL || '').trim();
  return v ? v.split(/\s+/) : null;
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: Number(process.env.RAVENRY_WIDTH) || 1440,
    height: Number(process.env.RAVENRY_HEIGHT) || 900,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Ravenry',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161618' : '#F1F0ED',
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 18, y: 18 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
      ...(OFFSCREEN ? { offscreen: true } : {}),
    },
  });
  if (OFFSCREEN) w.webContents.setFrameRate(60);
  w.loadFile(path.join(__dirname, 'index.html'));
  if (!OFFSCREEN) w.once('ready-to-show', () => w.show());
  // Links open in the browser, never in this window.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) outside('url', url, () => void shell.openExternal(url));
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.on('closed', () => { if (win === w) win = null; });
  return w;
}

function menu(): void {
  const cmd = (name: string, arg?: unknown) => () => send('command', name, arg);
  // On Linux, Ctrl+T, Ctrl+W and Ctrl+digit belong to the shell; the app's
  // shortcuts there take Shift as well, as terminals on Linux do.
  const mod = isMac ? 'Cmd' : 'Ctrl+Shift';
  const tabs: MenuItemConstructorOptions[] = Array.from({ length: 9 }, (_, i) => ({
    label: `Tab ${i + 1}`, accelerator: `${isMac ? 'Cmd' : 'Alt'}+${i + 1}`, click: cmd('tab', i), visible: false,
  }));
  const u = updates.state;
  const updateItem: MenuItemConstructorOptions = u.kind === 'ready'
    ? { label: `Restart to Update to ${u.version}`, click: () => updates.installNow() }
    : { label: 'Check for Updates…', click: () => void updates.checkNow(win) };
  // After the switch from the npm board, the way back (asked in the window first).
  const backItems: MenuItemConstructorOptions[] = npm.detect && npm.detect.record && npm.detect.record.state === 'switched'
    ? [{ label: 'Go Back to the npm Board…', click: () => { npm.confirmBack = true; pushNpm(); } }] : [];
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        updateItem,
        ...backItems,
        { type: 'separator' as const },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => openSettings() },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const }, { role: 'hideOthers' as const }, { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'Shell',
      submenu: [
        { label: 'New Shell', accelerator: `${mod}+T`, click: cmd('new-shell') },
        { label: 'New Session', accelerator: `${mod}+N`, click: cmd('new-session') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: `${mod}+W`, click: cmd('close-tab') },
        ...(isMac ? [] : [{ type: 'separator' as const }, { role: 'quit' as const }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'copy', accelerator: isMac ? 'Cmd+C' : 'Ctrl+Shift+C' },
        { role: 'paste', accelerator: isMac ? 'Cmd+V' : 'Ctrl+Shift+V' },
        { role: 'selectAll', accelerator: isMac ? 'Cmd+A' : 'Ctrl+Shift+A' },
        ...(isMac ? [] : [{ type: 'separator' as const }, { label: 'Settings…', accelerator: 'Ctrl+,', click: () => openSettings() }]),
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Session Panel', accelerator: isMac ? 'Cmd+Alt+B' : 'Ctrl+Shift+B', click: cmd('toggle-panel') },
        { type: 'separator' },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: cmd('next-tab', 1) },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: cmd('next-tab', -1) },
        ...(isMac ? [
          { label: 'Next Tab ', accelerator: 'Cmd+Shift+]', click: cmd('next-tab', 1), visible: false },
          { label: 'Previous Tab ', accelerator: 'Cmd+Shift+[', click: cmd('next-tab', -1), visible: false },
        ] : []),
        ...tabs,
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
    ...(isMac ? [] : [{ label: 'Help', submenu: [updateItem, ...backItems] }]),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function ipc(): void {
  ipcMain.on('daemon:connect', async (e, req: number, socket: string | null) => {
    try {
      await daemon.connect(e.sender, req, socket);
    } catch (err) {
      e.sender.send('daemon:error', req, String((err as Error).message || err), daemon.where());
    }
  });
  ipcMain.on('daemon:reset', () => daemon.reset());
  ipcMain.on('app:log', (_e, line: string) => appLog(String(line).slice(0, 2000)));
  // The running daemons, newest first: the window lists its plain shells on each.
  ipcMain.handle('daemon:sockets', () => listSockets(runtimeDir()).map((s) => s.socket));
  ipcMain.handle('app:config', () => ({
    platform: process.platform,
    hubUrl: feed ? feed.url : hubUrl(),
    newShell: newShellCommand(),
    home: os.homedir(),
    offscreen: OFFSCREEN,
    hookBin: hookBin(),
  }));
  ipcMain.handle('hub:state', () => ({ state: feed?.last ?? null, status: feed?.status ?? null }));
  ipcMain.handle('hub:get', (_e, p: string) => hubGet(feed!.url, p));
  ipcMain.handle('hub:post', (_e, p: string, body: unknown) => hubPost(feed!.url, p, body));
  ipcMain.handle('hub:answer', (_e, body: unknown) => hubAnswer(feed!.url, body));
  ipcMain.handle('local:folders', (_e, root?: string) => findProjectFolders(os.homedir(), 5, root || undefined));
  ipcMain.handle('local:assistants', () => findAssistants(process.env, os.homedir()));
  ipcMain.handle('local:short', (_e, p: string) => shortPath(p, os.homedir()));
  ipcMain.handle('local:choose-folder', async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: os.homedir() });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  ipcMain.handle('store:get', () => store.get());
  // "Try again" on an update that stopped after 3 tries: the count starts over.
  ipcMain.on('update:retry', () => { store.set({ update: null }); if (lastStaged && !retrying) { retrying = true; appLog('launch: update tried again from the window'); void setUpService(lastStaged).finally(() => { retrying = false; }); } });
  ipcMain.on('store:set', (_e, patch: Record<string, unknown>) => store.set(patch));
  ipcMain.on('focus-window', () => {
    if (!win || OFFSCREEN) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  ipcMain.on('open-external', (_e, url: string) => { if (/^https?:\/\//.test(url)) outside('url', url, () => void shell.openExternal(url)); });
  // A page's file, an item's file or its folder, in the person's editor or
  // file manager: only page files, markdown items and folders.
  ipcMain.on('open-path', (_e, p: string) => {
    if (typeof p !== 'string' || !path.isAbsolute(p) || !(/\.(page\.yaml|md)$/i.test(p) || isDir(p))) return;
    outside('path', p, () => void shell.openPath(p));
  });
  ipcMain.on('copy-text', (_e, text: string) => { if (typeof text === 'string' && text.length <= 64 * 1024) outside('copy', text, () => clipboard.writeText(text)); });
  // Paste in the terminal (keymap.ts Cmd+V): offscreen a test's own text
  // (RAVENRY_TEST_CLIPBOARD), never the person's clipboard.
  ipcMain.handle('clipboard:read', () => (OFFSCREEN ? process.env.RAVENRY_TEST_CLIPBOARD || '' : clipboard.readText()));
  ipcMain.handle('hub:call', (_e, method: string, p: string, body: unknown) => hubCall(feed!.url, method, p, body));
  // The switch from the npm board (npmswitch.ts): the window's answers.
  ipcMain.handle('npm:state', () => npmView());
  ipcMain.handle('npm:switch', () => switchFromNpm());
  ipcMain.handle('npm:not-now', () => { store.set({ npmChoice: 'not-now' }); npm.offer = offerFor(npm.detect, 'not-now'); pushNpm(); return npmView(); });
  ipcMain.handle('npm:back', () => backToNpm());
  ipcMain.handle('npm:confirm-back', (_e, on: boolean) => { npm.confirmBack = !!on; pushNpm(); return npmView(); });
}

const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// What leaves the window for the person's own apps (a browser, an editor,
// the clipboard). Offscreen (tests, screenshots) nothing does: it is
// written to RAVENRY_OPEN_LOG instead, so no window opens on the screen.
function outside(kind: string, what: string, act: () => void): void {
  if (!OFFSCREEN) { act(); return; }
  const log = process.env.RAVENRY_OPEN_LOG;
  if (log) { try { fs.appendFileSync(log, JSON.stringify({ kind, what, at: new Date().toISOString() }) + '\n'); } catch { /* the test went */ } }
}

// The packaged app's ravenryd and hub, copied out of the app for this
// version (install.ts). Null in development.
function stage(): Staged | null {
  const build = app.isPackaged ? readBuildInfo(process.resourcesPath) : null;
  if (!build) return null;
  try {
    const staged = stageVersion({ resources: process.resourcesPath, root: dataRoot(), build });
    daemon.useOwn(staged.ravenryd, build.version);
    return staged;
  } catch (e) {
    console.error('install: could not copy ravenryd and the hub out of the app:', e);
    return null;
  }
}

async function boardAnswers(): Promise<boolean> {
  try { return (await fetch(hubUrl() + '/api/state', { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
}

// The hub as a user service, installed or brought up to this version, then
// version folders nothing runs from any more are removed.
let settingUp: Promise<void> | null = null;

function serviceRun(cmd: string, args: string[]): { status: number | null; out: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000 });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

let lastStaged: Staged | null = null;
let retrying = false;
async function setUpService(staged: Staged, opts: { port?: number; restart?: boolean } = {}): Promise<void> {
  lastStaged = staged;
  const mode = serviceMode(process.env, app.isPackaged);
  const run = serviceRun;
  try {
    let execPath = process.execPath;
    const from = runtimeSource(process.execPath);
    const build = readBuildInfo(process.resourcesPath);
    if (from && build && mode !== 'off') execPath = await stageRuntime({ from, staged, build, exeName: path.basename(process.execPath) });
    // The npm board's port when it ran on another (PORT=4700 ravenry).
    const env = opts.port && opts.port !== 4600 ? { ...process.env, PORT: String(opts.port) } : process.env;
    const port = opts.port || Number(new URL(hubUrl()).port) || 4600;
    // An update (the service runs another version's hub): each attempt is
    // said in app.log; after 3 failures in a row it stops, and the window
    // says why. A success clears the count.
    let before: string | null = null;
    try { before = fs.readFileSync(serviceFile(), 'utf8'); } catch { /* none yet */ }
    const updating = mode !== 'off' && mode !== 'dry-run' && !!before && !before.includes(`${path.sep}versions${path.sep}${staged.version}${path.sep}`);
    const rec = (store.get().update || null) as { version?: string; attempts?: number; why?: string } | null;
    const { attempt, stop } = updateAttempt(rec, staged.version);
    if (updating && stop) {
      appLog(`launch: update to ${staged.version} stopped after 3 failed attempts: ${rec?.why || ''}`);
      send('command', 'update-stopped', `The update to ${staged.version} did not start after 3 tries (${rec?.why || 'the new hub did not answer'}), so Ravenry keeps the hub that runs now.`);
      return;
    }
    if (updating) appLog(`launch: update to ${staged.version}, attempt ${attempt}`);
    const r = await ensureService({ mode, spec: serviceSpec({ execPath, staged, env }), run, boardAnswers, restart: opts.restart, answers: () => newHubAnswers(port) });
    const would = mode === 'dry-run' ? `; would run: ${r.commands.map((c) => c.join(' ')).join('; ')}` : '';
    appLog(`service: ${r.state}${r.file ? ` ${r.file}` : ''}${r.why ? ` (${r.why})` : ''}${would}`);
    if (updating) store.set({ update: r.state === 'failed' ? { version: staged.version, attempts: attempt, why: r.why || '' } : null });
    if (updating && r.state === 'failed' && attempt >= 3) send('command', 'update-stopped', `The update to ${staged.version} did not start after 3 tries (${r.why || 'the new hub did not answer'}), so Ravenry keeps the hub that runs now.`);
    // An older version's folder goes only once this build's hub runs: never
    // after a failed update, whose fallback runs from it.
    if (r.state === 'failed') return;
  } catch (e) {
    appLog(`service: ${(e as Error).message || e}`);
    return;
  }
  setTimeout(() => {
    let svc: string | null = null;
    try { svc = fs.readFileSync(serviceFile(), 'utf8'); } catch { /* none */ }
    const running = listSockets(runtimeDir()).map((s) => s.version);
    // What runs from a version folder (any process's command line), and
    // the hooks that name one.
    const inUse: string[] = [];
    try { inUse.push(spawnSync('/bin/ps', ['-axww', '-o', 'command='], { encoding: 'utf8', timeout: 10000 }).stdout || ''); } catch { /* none */ }
    for (const f of [path.join(os.homedir(), '.claude', 'settings.json'), path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json')]) {
      try { inUse.push(fs.readFileSync(f, 'utf8')); } catch { /* none */ }
    }
    const gone = pruneVersions(dataRoot(), staged.version, running, svc, inUse);
    if (gone.length) appLog(`install: removed versions nothing runs from: ${gone.join(', ')}`);
  }, OFFSCREEN ? 0 : 60000).unref();
}

// Whether a hub answers on this port within `ms`: any HTTP answer counts (a
// hub waiting for macOS's privacy answer says 503 and is alive).
// The new hub after an update: up to 60 s for it to listen (a first launch
// of a fresh copy waits on macOS's checks), then 30 s from its listen for
// any HTTP answer. The 30 s used to count from the bootstrap, so a hub that
// took long to start used part of them before it could answer.
async function newHubAnswers(port: number): Promise<boolean> {
  const t0 = Date.now();
  const open = () => new Promise<boolean>((r) => {
    const s = net.connect(port, '127.0.0.1');
    const done = (v: boolean) => { s.destroy(); r(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(1000, () => done(false));
  });
  let listening = false;
  while (!listening && Date.now() - t0 < 60000) { listening = await open(); if (!listening) await new Promise((r) => setTimeout(r, 250)); }
  if (!listening) { appLog('service: the new hub did not listen within 60 s'); return false; }
  const at = Date.now();
  const wait = 30000;
  appLog(`service: the new hub listened ${at - t0} ms after it started; waiting up to ${wait / 1000} s for its answer`);
  const ok = await hubAnswers(port, wait);
  appLog(`service: the new hub ${ok ? `answered ${Date.now() - at} ms after it listened` : `did not answer within ${wait / 1000} s of its listen`}`);
  return ok;
}

async function hubAnswers(port: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { await fetch(`http://127.0.0.1:${port}/api/whoami`, { signal: AbortSignal.timeout(2000) }); return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ------------------------------------------------------------ the npm board

// What the window shows of the switch (npmswitch.ts), and where it is.
// `from` is what was found when the person agreed (the steps the window
// lists), `steps` each one done so far, `counts` what the app's hub shows
// once it answers.
type NpmStep = { id: string; [k: string]: unknown };
const npm: { detect: NpmDetect | null; from: NpmDetect | null; offer: Offer; phase: 'idle' | 'switching' | 'switched' | 'going-back' | 'back' | 'error'; message: string | null; log: string[]; steps: NpmStep[]; counts: Record<string, number> | null; result: unknown; confirmBack: boolean } = {
  detect: null, from: null, offer: 'none', phase: 'idle', message: null, log: [], steps: [], counts: null, result: null, confirmBack: false,
};
let staged: Staged | null = null;

function npmView(): object {
  return { offer: npm.offer, phase: npm.phase, message: npm.message, log: npm.log, steps: npm.steps, counts: npm.counts, result: npm.result, confirmBack: npm.confirmBack, detect: npm.detect, from: npm.from, platform: process.platform };
}
function pushNpm(): void { send('npm:state', npmView()); menu(); }

// The hub script of this version (the staged hub), run as Node on the
// app's own executable. Only a packaged app switches: a development run
// starts no hub of its own.
function npmScript(args: string[], onLog?: (l: string) => void): Promise<Record<string, unknown> & { ok: boolean; error?: string }> {
  if (!staged) return Promise.resolve({ ok: false, error: 'A development run starts no hub of its own, so it cannot switch.' });
  return runScript({ exe: process.execPath, script: scriptPath(staged.hubEntry), args: [...args, '--app-data', dataRoot()], env: { ...process.env, RAVENRY_LAUNCHCTL: launchctlBin() }, onLog });
}

async function detectNpm(): Promise<void> {
  if (!staged) return;
  const d = await npmScript(['detect']) as unknown as NpmDetect;
  npm.detect = d.ok ? d : null;
  if (!d.ok) console.error('npm board: could not look for it:', d.error);
  npm.offer = offerFor(npm.detect, (store.get().npmChoice as string) || null);
  if (npm.detect && npm.detect.npm) {
    const b = npm.detect.board;
    console.log(`npm board: ${b && !b.own ? `running (pid ${b.pid}, :${b.port}, ${b.version || 'unknown version'})` : 'not running'}, ${npm.detect.login.length} login start(s), ${npm.detect.hooks.claude.length + npm.detect.hooks.codex.length} hook(s); the app starts no hub of its own until the switch`);
  }
}

// The hub at launch: none of the app's own beside the npm board; once
// switched, the app's service is brought up to this build whatever traces
// of the npm board are left, and those are moved as the switch would
// (launchPlan in npmswitch.ts).
async function startHub(st: Staged): Promise<void> {
  await detectNpm();
  let installed = false;
  try { installed = fs.existsSync(serviceFile()); } catch { /* none */ }
  const plan = launchPlan(npm.detect, installed);
  appLog(`launch: ${plan} (npm board traces: ${npm.detect ? (npm.detect.npm ? 'yes' : 'none') : 'not looked at'}, service ${installed ? 'installed' : 'not installed'})`);
  if (plan === 'finish') {
    npm.offer = 'none';
    pushNpm();
    const r = await npmScript(['switch', '--ravenryd', hookBin() || '']);
    appLog(`npm board: finished the switch: ${r.ok ? 'its traces moved' : r.error || 'it stopped'}`);
    await detectNpm();
  }
  pushNpm();
  if (plan === 'offer') return;
  await setUpService(st);
}

// A line in the app's log (~/Library/Logs/Ravenry/app.log, or
// ~/.local/state/ravenry/app.log), beside the hub's: what the app did with
// its hub service at launch, which a Finder-started app has nowhere else to
// say. Only the packaged app writes it.
function appLog(line: string): void {
  console.log(line);
  if (!app.isPackaged) return;
  try {
    const dir = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Logs', 'Ravenry') : path.join(os.homedir(), '.local', 'state', 'ravenry');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'app.log'), `${new Date().toISOString()} ${line}\n`);
  } catch { /* no log: the app goes on */ }
}

async function waitForHub(port: number, ms = 30000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(1500) })).ok) return true; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// The person agreed: the npm board stops, its login start and hooks move,
// and the app's hub starts on the same data and port.
async function switchFromNpm(): Promise<object> {
  if (npm.phase === 'switching' || npm.phase === 'going-back') return npmView();
  npm.phase = 'switching'; npm.message = null; npm.log = []; npm.steps = []; npm.counts = null; npm.result = null; npm.from = npm.detect;
  pushNpm();
  const r = await npmScript(['switch', '--ravenryd', hookBin() || ''], (l) => {
    if (l.startsWith('@step ')) { try { npm.steps.push(JSON.parse(l.slice(6))); } catch { /* a cut line */ } } else npm.log.push(l);
    pushNpm();
  });
  if (!r.ok) { npm.phase = 'error'; npm.message = r.error || 'The switch stopped.'; pushNpm(); return npmView(); }
  const rec = (r as { record?: { port?: number } }).record || {};
  const port = Number(rec.port) || 4600;
  npm.log.push(`hub: starting the app's hub on :${port}`);
  const hubStep: NpmStep = { id: 'hub', port, done: false };
  npm.steps.push(hubStep);
  pushNpm();
  if (staged) await setUpService(staged, { port, restart: true });
  const up = await waitForHub(port);
  if (up) { hubStep.done = true; npm.counts = await hubCounts(port); }
  await detectNpm();
  store.set({ npmChoice: 'switched' });
  npm.result = r;
  npm.phase = up ? 'switched' : 'error';
  npm.message = up ? null : `The npm board is stopped and the hooks moved, but the app's hub did not answer on :${port}. Its log: ~/Library/Logs/Ravenry/hub.log`;
  npm.offer = 'none';
  pushNpm();
  return npmView();
}

// What the person cares about, as the app's hub now shows it.
async function hubCounts(port: number): Promise<Record<string, number> | null> {
  const url = `http://127.0.0.1:${port}`;
  try {
    const st = await hubGet(url, '/api/state') as { projects?: { hidden?: boolean; sessions?: unknown[]; plan?: unknown }[] };
    const projects = (st.projects || []).filter((p) => !p.hidden);
    const ideas = await hubGet(url, '/api/ideas').catch(() => ({})) as { ideas?: { archived?: boolean }[] };
    const rules = await hubGet(url, '/api/rules/mine').catch(() => ({})) as { count?: number };
    return {
      projects: projects.length,
      sessions: projects.reduce((n, p) => n + (p.sessions || []).length, 0),
      ideas: (ideas.ideas || []).filter((i) => !i.archived).length,
      plans: projects.filter((p) => p.plan).length,
      rules: Number(rules.count) || 0,
    };
  } catch { return null; }
}

// The way back: the app's hub stops and leaves, then the hub script puts
// the ideas, hooks and login start back.
async function backToNpm(): Promise<object> {
  if (npm.phase === 'switching' || npm.phase === 'going-back') return npmView();
  npm.phase = 'going-back'; npm.message = null; npm.log = []; npm.result = null; npm.confirmBack = false;
  pushNpm();
  const rm = removeService({ mode: serviceMode(process.env, app.isPackaged), run: serviceRun });
  npm.log.push(`hub: the app's hub service ${rm.state === 'off' ? 'was not installed' : 'is stopped and removed'}`);
  pushNpm();
  // Its board.json goes when it exits.
  const bj = path.join(process.env.RAVENRY_HOME || path.join(os.homedir(), '.ravenry'), 'board.json');
  for (let i = 0; i < 100; i++) {
    let pid = 0;
    try { pid = Number(JSON.parse(fs.readFileSync(bj, 'utf8')).pid) || 0; } catch { break; }
    try { process.kill(pid, 0); } catch { break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await npmScript(['back'], (l) => { npm.log.push(l); pushNpm(); });
  npm.result = r;
  if (!r.ok) { npm.phase = 'error'; npm.message = r.error || 'Going back stopped.'; pushNpm(); return npmView(); }
  store.set({ npmChoice: 'back' });
  await detectNpm();
  npm.phase = 'back';
  npm.offer = offerFor(npm.detect, 'back');
  pushNpm();
  return npmView();
}

app.whenReady().then(async () => {
  if (leaving) return;
  if (OFFSCREEN && isMac) app.dock?.hide();
  store = new Store(app.getPath('userData'));
  initSettings({ dir: app.getPath('userData'), offscreen: OFFSCREEN });
  staged = stage();
  ipc();
  menu();
  feed = new HubFeed(hubUrl(), (s) => send('hub:state', s), (st: HubStatus) => send('hub:status', st));
  feed.start();
  win = createWindow();
  if (staged) settingUp = startHub(staged).finally(() => { settingUp = null; });
  if (!OFFSCREEN) updates.start();
  if (RAVENRY_TEST_HOOKS && process.env.RAVENRY_DRIVER) {
    // Tests and screenshots: a script outside the app drives the window.
    // Never in a release build: this block is not in it (gate.ts).
    const drive = require(process.env.RAVENRY_DRIVER) as (w: BrowserWindow, ctx: object) => Promise<void>;
    win.webContents.once('did-finish-load', () => {
      drive(win!, { app, daemon }).then(() => app.quit(), (e) => { console.error('driver:', e); app.exit(1); });
    });
  }
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('activate', () => {
  if (!win && app.isReady()) win = createWindow();
  // The app still ran (its window closed): coming back to it is a launch
  // too for an update that failed, so it is tried again (counted, logged).
  const rec = (store?.get().update || null) as { attempts?: number } | null;
  if (rec && (rec.attempts || 0) < 3 && lastStaged && !retrying) { retrying = true; void setUpService(lastStaged).finally(() => { retrying = false; }); }
});
app.on('window-all-closed', () => { if (!isMac || OFFSCREEN) app.quit(); });
app.on('before-quit', () => { store?.flush(); feed?.stop(); updates.stop(); });
// A quit while the service is being set up (an AppImage copying its
// runtime takes a few seconds) waits for it, up to 30 s, so it is never left
// half written.
app.on('will-quit', (e) => {
  if (!settingUp) return;
  e.preventDefault();
  void Promise.race([settingUp, new Promise((r) => setTimeout(r, 30000))]).then(() => { settingUp = null; app.quit(); });
});
