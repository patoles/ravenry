// Updates, from the GitHub Releases of the repository the app was built
// from (resources/app-update.yml, written by electron-builder). macOS and
// the Linux AppImage update themselves: a new version downloads in the
// background and installs when the app quits, or at once from the menu. A
// .deb does not, and says so when asked.
//
// Updating never ends a session: sessions live in ravenryd, outside the
// app. The new version's ravenryd starts beside the old one on the next
// launch, and the old one keeps its panes until they end (PROTOCOL.md
// section 9); the hub service is restarted onto the new version.
//
// Releases are public once the repository is. Until then the check fails
// quietly (GitHub answers 404 without a token); RAVENRY_UPDATE_TOKEN, a
// GitHub token with read access, lets a maintainer test updates from the
// private repository. No token is ever built into the app.
//
//   RAVENRY_UPDATES=0      never check

import fs from 'node:fs';
import path from 'node:path';
import { app, dialog, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { selfUpdating } from './install.ts';

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'downloading'; version: string }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string };

const FIRST_CHECK_MS = 15000;
const EVERY_MS = 4 * 3600 * 1000;

/** owner and repo from resources/app-update.yml, when the app was packaged with one. */
export function updateSource(resources: string): { owner: string; repo: string } | null {
  try {
    const t = fs.readFileSync(path.join(resources, 'app-update.yml'), 'utf8');
    const owner = /^owner:\s*['"]?([^'"\s]+)/m.exec(t)?.[1];
    const repo = /^repo:\s*['"]?([^'"\s]+)/m.exec(t)?.[1];
    return owner && repo ? { owner, repo } : null;
  } catch { return null; }
}

export class Updates {
  state: UpdateState = { kind: 'idle' };
  private onState: (s: UpdateState) => void;
  private resources: string;
  private started = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(resources: string, onState: (s: UpdateState) => void) {
    this.resources = resources;
    this.onState = onState;
  }

  /** Whether this copy can update itself, and if not, why. */
  support(): { ok: true } | { ok: false; why: string } {
    if (!app.isPackaged) return { ok: false, why: 'This is a development build. It does not update itself.' };
    if (!updateSource(this.resources)) return { ok: false, why: 'This build does not say where its updates come from.' };
    if (!selfUpdating()) {
      return { ok: false, why: 'This copy of Ravenry was installed from a .deb package, which does not update itself. Download the new .deb from the releases page and install it over this one.' };
    }
    return { ok: true };
  }

  releasesUrl(): string | null {
    const s = updateSource(this.resources);
    return s ? `https://github.com/${s.owner}/${s.repo}/releases` : null;
  }

  private set(s: UpdateState): void {
    this.state = s;
    this.onState(s);
  }

  /** Checks a little after launch, then every few hours. Does nothing where updates are off. */
  start(): void {
    if (this.started || process.env.RAVENRY_UPDATES === '0' || !this.support().ok) return;
    this.started = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = { info: (m: unknown) => console.log('updates:', m), warn: (m: unknown) => console.warn('updates:', m), error: (m: unknown) => console.error('updates:', m), debug: () => {} };
    const token = process.env.RAVENRY_UPDATE_TOKEN;
    const src = updateSource(this.resources);
    if (token && src) autoUpdater.setFeedURL({ provider: 'github', owner: src.owner, repo: src.repo, private: true, token });
    autoUpdater.on('checking-for-update', () => this.set({ kind: 'checking' }));
    autoUpdater.on('update-not-available', () => this.set({ kind: 'idle' }));
    autoUpdater.on('update-available', (i) => this.set({ kind: 'downloading', version: i.version }));
    autoUpdater.on('update-downloaded', (i) => this.set({ kind: 'ready', version: i.version }));
    autoUpdater.on('error', (e) => this.set({ kind: 'error', message: String((e as Error)?.message || e).split('\n')[0] }));
    const quiet = () => { autoUpdater.checkForUpdates().catch(() => { /* reported through 'error' */ }); };
    this.timer = setTimeout(quiet, FIRST_CHECK_MS);
    setInterval(quiet, EVERY_MS).unref();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  /** The menu's Check for Updates: says what it found. */
  async checkNow(win: BrowserWindow | null): Promise<void> {
    const box = (o: Electron.MessageBoxOptions) => (win ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o));
    const support = this.support();
    const url = this.releasesUrl();
    if (!support.ok) {
      const r = await box({ type: 'info', message: 'Updates', detail: support.why, buttons: url ? ['Open the Releases Page', 'OK'] : ['OK'], defaultId: 0 });
      if (url && r.response === 0) void shell.openExternal(url);
      return;
    }
    if (this.state.kind === 'ready') return this.offerRestart(win);
    this.start();
    try {
      const r = await autoUpdater.checkForUpdates();
      const v = r?.updateInfo?.version;
      if (r?.isUpdateAvailable && v) {
        await box({ type: 'info', message: `Ravenry ${v} is downloading`, detail: 'It installs when you quit Ravenry. Your sessions keep running through the update.', buttons: ['OK'] });
      } else {
        await box({ type: 'info', message: 'Ravenry is up to date', detail: `You have ${app.getVersion()}, the newest version.`, buttons: ['OK'] });
      }
    } catch (e) {
      const message = String((e as Error)?.message || e).split('\n')[0];
      const r = await box({ type: 'warning', message: 'Could not check for updates', detail: message, buttons: url ? ['Open the Releases Page', 'OK'] : ['OK'], defaultId: 1 });
      if (url && r.response === 0) void shell.openExternal(url);
    }
  }

  async offerRestart(win: BrowserWindow | null): Promise<void> {
    if (this.state.kind !== 'ready') return;
    const o: Electron.MessageBoxOptions = {
      type: 'info',
      message: `Ravenry ${this.state.version} is ready`,
      detail: 'Restart Ravenry to use it. Your sessions keep running: they are not part of the window.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    };
    const r = win ? await dialog.showMessageBox(win, o) : await dialog.showMessageBox(o);
    if (r.response === 0) this.installNow();
  }

  installNow(): void {
    if (this.state.kind === 'ready') autoUpdater.quitAndInstall(false, true);
  }
}
