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
//   RAVENRY_OFFSCREEN=1    never show the window (tests and screenshots)
//   RAVENRY_DRIVER         a script that drives the window (tools/)
//   RAVENRY_SERVICE        install, dry-run or off: the hub service
//                          (install.ts; default: install when packaged)
//   RAVENRY_UPDATES=0      never check for updates (updater.ts)
//
// The home folder is HOME (os.homedir), so a test's throwaway HOME is used
// for everything the app reads there.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { listSockets, runtimeDir } from '@ravenry/client/node';
import { DaemonLink } from './daemon.ts';
import { HubFeed, hubGet, hubPost, hubUrl } from './hub.ts';
import type { HubStatus } from './hub.ts';
import { dataRoot, ensureService, pruneVersions, readBuildInfo, runtimeSource, serviceFile, serviceMode, serviceSpec, stageRuntime, stageVersion } from './install.ts';
import type { Staged } from './install.ts';
import { findAssistants, findProjectFolders, shortPath, Store } from './local.ts';
import { Updates } from './updater.ts';

const APP_ROOT = path.resolve(__dirname, '..');
const OFFSCREEN = process.env.RAVENRY_OFFSCREEN === '1';
const isMac = process.platform === 'darwin';

app.setName('Ravenry');
if (process.env.RAVENRY_DESKTOP_DATA) app.setPath('userData', process.env.RAVENRY_DESKTOP_DATA);
if (process.env.RAVENRY_THEME === 'dark' || process.env.RAVENRY_THEME === 'light') nativeTheme.themeSource = process.env.RAVENRY_THEME;

// Two windows on one set of tabs would fight over them.
if (!OFFSCREEN && !app.requestSingleInstanceLock()) app.exit(0);

const daemon = new DaemonLink(APP_ROOT);
let store: Store;
let win: BrowserWindow | null = null;
let feed: HubFeed | null = null;
const updates = new Updates(process.resourcesPath, () => menu());

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
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
    if (/^https?:/.test(url)) void shell.openExternal(url);
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
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        updateItem,
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
    ...(isMac ? [] : [{ label: 'Help', submenu: [updateItem] }]),
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
  ipcMain.handle('app:config', () => ({
    platform: process.platform,
    hubUrl: feed ? feed.url : hubUrl(),
    newShell: newShellCommand(),
    home: os.homedir(),
    offscreen: OFFSCREEN,
  }));
  ipcMain.handle('hub:state', () => ({ state: feed?.last ?? null, status: feed?.status ?? null }));
  ipcMain.handle('hub:get', (_e, p: string) => hubGet(feed!.url, p));
  ipcMain.handle('hub:post', (_e, p: string, body: unknown) => hubPost(feed!.url, p, body));
  ipcMain.handle('local:folders', (_e, root?: string) => findProjectFolders(os.homedir(), 5, root || undefined));
  ipcMain.handle('local:assistants', () => findAssistants(process.env, os.homedir()));
  ipcMain.handle('local:short', (_e, p: string) => shortPath(p, os.homedir()));
  ipcMain.handle('local:choose-folder', async () => {
    if (!win) return null;
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: os.homedir() });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  ipcMain.handle('store:get', () => store.get());
  ipcMain.on('store:set', (_e, patch: Record<string, unknown>) => store.set(patch));
  ipcMain.on('focus-window', () => {
    if (!win || OFFSCREEN) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  ipcMain.on('open-external', (_e, url: string) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); });
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

async function setUpService(staged: Staged): Promise<void> {
  const mode = serviceMode(process.env, app.isPackaged);
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000 });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  try {
    let execPath = process.execPath;
    const from = runtimeSource(process.execPath);
    const build = readBuildInfo(process.resourcesPath);
    if (from && build && mode !== 'off') execPath = await stageRuntime({ from, staged, build, exeName: path.basename(process.execPath) });
    const r = await ensureService({ mode, spec: serviceSpec({ execPath, staged }), run, boardAnswers });
    const would = mode === 'dry-run' ? `; would run: ${r.commands.map((c) => c.join(' ')).join('; ')}` : '';
    console.log(`service: ${r.state}${r.file ? ` ${r.file}` : ''}${r.why ? ` (${r.why})` : ''}${would}`);
  } catch (e) {
    console.error('service:', e);
  }
  setTimeout(() => {
    let svc: string | null = null;
    try { svc = fs.readFileSync(serviceFile(), 'utf8'); } catch { /* none */ }
    const running = listSockets(runtimeDir()).map((s) => s.version);
    const gone = pruneVersions(dataRoot(), staged.version, running, svc);
    if (gone.length) console.log(`install: removed versions nothing runs from: ${gone.join(', ')}`);
  }, OFFSCREEN ? 0 : 60000).unref();
}

app.whenReady().then(async () => {
  if (OFFSCREEN && isMac) app.dock?.hide();
  store = new Store(app.getPath('userData'));
  const staged = stage();
  ipc();
  menu();
  feed = new HubFeed(hubUrl(), (s) => send('hub:state', s), (st: HubStatus) => send('hub:status', st));
  feed.start();
  win = createWindow();
  if (staged) settingUp = setUpService(staged).finally(() => { settingUp = null; });
  if (!OFFSCREEN) updates.start();
  if (process.env.RAVENRY_DRIVER) {
    // Tests and screenshots: a script outside the app drives the window.
    const drive = require(process.env.RAVENRY_DRIVER) as (w: BrowserWindow, ctx: object) => Promise<void>;
    win.webContents.once('did-finish-load', () => {
      drive(win!, { app, daemon }).then(() => app.quit(), (e) => { console.error('driver:', e); app.exit(1); });
    });
  }
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('activate', () => { if (!win && app.isReady()) win = createWindow(); });
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
