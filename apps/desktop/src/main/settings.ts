// The terminal settings in the main process: the store
// (settingsstore.ts), the IPC every window uses (docs/SETTINGS.md) and the
// Settings window (Cmd+, from the app menu; src/settings/ is its page).

import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell } from 'electron';
import { terminalSettings } from '../shared/settings.ts';
import type { SettingsSnapshot, SettingsTab } from '../shared/settings.ts';
import type { Appearance } from '../shared/themes.ts';
import { SettingsStore } from './settingsstore.ts';

const WIDTH = 720;
let store: SettingsStore;
let offscreen = false;
let settingsWin: BrowserWindow | null = null;
let lastTab: SettingsTab = 'appearance';

const appearance = (): Appearance => (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');

export function snapshot(): SettingsSnapshot {
  const a = appearance();
  return { settings: store.get(), themes: store.themes(), appearance: a, terminal: terminalSettings(store.get(), store.themes(), a) };
}

function broadcast(): void {
  const s = snapshot();
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('settings:changed', s);
}

/** The store and the IPC. Call once, when the app is ready, before any window loads. */
export function initSettings(opts: { dir: string; offscreen: boolean }): SettingsStore {
  offscreen = opts.offscreen;
  store = new SettingsStore(opts.dir);
  for (const p of store.problems) console.log(`settings: ${p}`);
  store.onChange(broadcast);
  nativeTheme.on('updated', broadcast);

  ipcMain.handle('settings:get', () => snapshot());
  ipcMain.handle('settings:set', (_e, patch: unknown) => {
    const r = store.set(patch);
    return r.ok ? { ok: true, snapshot: snapshot() } : r;
  });
  ipcMain.handle('settings:import-theme', async (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    let file: string | null = null;
    if (offscreen) {
      // Tests: never a dialog on screen; the file comes from the test.
      file = process.env.RAVENRY_SETTINGS_IMPORT || null;
    } else {
      const opts = { title: 'Import a Theme', buttonLabel: 'Import', properties: ['openFile' as const], filters: [{ name: 'iTerm2 or Ghostty theme', extensions: ['itermcolors', '*'] }] };
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts);
      file = r.canceled ? null : r.filePaths[0] || null;
    }
    if (!file) return { ok: false, canceled: true };
    let text: string;
    try {
      if (fs.statSync(file).size > 1024 * 1024) return { ok: false, error: 'The file is too big for a theme (over 1 MB).' };
      text = fs.readFileSync(file, 'utf8');
    } catch (err) { return { ok: false, error: `Ravenry could not read ${path.basename(file)}: ${(err as Error).message}` }; }
    const r = store.importTheme(text, path.basename(file));
    return r.ok ? { ok: true, theme: r.theme, snapshot: snapshot() } : r;
  });
  // A bell rang in a terminal: the sound and the Dock bounce are the main
  // process's (the visual bell is the window's own).
  ipcMain.on('settings:bell', (e) => {
    const s = store.get();
    if (s.bell === 'off' || offscreen) return;
    if (s.bell === 'sound') shell.beep();
    const w = BrowserWindow.fromWebContents(e.sender);
    if (s.bellBounceDock && process.platform === 'darwin' && !(w && w.isFocused()) && !BrowserWindow.getFocusedWindow()) app.dock?.bounce('informational');
  });
  // The Settings window's own: its height follows its tab, its title is the tab's name.
  ipcMain.on('settings:size', (e, height: number) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || w !== settingsWin || !Number.isFinite(height)) return;
    w.setContentSize(WIDTH, Math.max(200, Math.min(1200, Math.round(height))), process.platform === 'darwin' && !offscreen);
  });
  ipcMain.on('settings:tab', (e, tab: SettingsTab) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w || w !== settingsWin || (tab !== 'appearance' && tab !== 'behavior')) return;
    lastTab = tab;
    w.setTitle(tab === 'appearance' ? 'Appearance' : 'Behavior');
  });
  ipcMain.on('settings:open', (_e, tab?: SettingsTab) => { openSettings(tab === 'appearance' || tab === 'behavior' ? tab : undefined); });
  ipcMain.handle('settings:window', () => ({ platform: process.platform, tab: lastTab, offscreen }));
  return store;
}

/** The Settings window: opened, or brought to the front on the tab asked for. */
export function openSettings(tab?: SettingsTab): BrowserWindow {
  if (tab) lastTab = tab;
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (tab) settingsWin.webContents.send('settings:show-tab', tab);
    if (!offscreen) { settingsWin.show(); settingsWin.focus(); }
    return settingsWin;
  }
  const mac = process.platform === 'darwin';
  // Its own session: the page may list the installed fonts (the Local
  // Font Access API), and nothing else changes for the main window.
  const ses = session.fromPartition('ravenry-settings');
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'local-fonts');
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'local-fonts'));
  const w = new BrowserWindow({
    width: WIDTH,
    height: 600,
    useContentSize: true,
    show: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    title: lastTab === 'appearance' ? 'Appearance' : 'Behavior',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1E1E21' : '#FFFFFF',
    ...(mac ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 14, y: 12 } } : { autoHideMenuBar: true }),
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.cjs'),
      partition: 'ravenry-settings',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      enableBlinkFeatures: 'FontAccess',
      ...(offscreen ? { offscreen: true } : {}),
    },
  });
  if (offscreen) w.webContents.setFrameRate(60);
  w.loadFile(path.join(__dirname, 'settings.html'));
  if (!offscreen) w.once('ready-to-show', () => w.show());
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.on('closed', () => { if (settingsWin === w) settingsWin = null; });
  settingsWin = w;
  return w;
}

export function settingsWindow(): BrowserWindow | null {
  return settingsWin && !settingsWin.isDestroyed() ? settingsWin : null;
}
