// window.ravenry, as the preload script exposes it.

import type { SettingsApi } from '../shared/settings.ts';
import type { SkillsApi } from '../shared/skills.ts';

export interface AppConfig {
  platform: string;
  hubUrl: string;
  newShell: string[] | null;
  home: string;
  offscreen: boolean;
  /** The ravenryd the hook setup points the assistants' hooks at, or null (no setup offered). */
  hookBin: string | null;
  /** The first window (it keeps the tabs); a window opened with Cmd+N is not. */
  primary?: boolean;
}

/** `starting`: the hub answers but waits for macOS to say whether it may read a folder (hub/server/access.mjs). */
export interface HubStatus { reachable: boolean; url: string; error?: string; starting?: { waitingFor: string | null; folder: string | null; path?: string | null; settings?: string | null } }
export interface FolderPick { name: string; path: string; short: string }
/** One assistant the hub lists (its registry's order, hub/server/assistants.mjs), found here or not. */
export interface AssistantInfo { kind: string; name: string; found: boolean; signedIn: boolean; path: string | null }
/** The first launch's Start screen: the hub's GET /api/setup/start (hub/server/firstlaunch.mjs). */
export interface StartView { root: string | null; folders: FolderPick[]; assistants: AssistantInfo[] }

export interface RavenryApi {
  config(): Promise<AppConfig>;
  connectDaemon(req: number, socket?: string): void;
  resetDaemon(): void;
  /** The sockets of the running daemons, newest first. */
  daemonSockets(): Promise<string[]>;
  hubState(): Promise<{ state: unknown; status: HubStatus | null }>;
  hubGet(p: string): Promise<unknown>;
  hubPost(p: string, body: unknown): Promise<unknown>;
  /** A checkpoint's answer through the hub; never rejects. 403: this window is not taken as the person. */
  hubAnswer(body: unknown): Promise<{ ok: boolean; status: number; error?: string; checkpoint?: unknown }>;
  onHubState(cb: (s: unknown) => void): () => void;
  onHubStatus(cb: (s: HubStatus) => void): () => void;
  onCommand(cb: (name: string, arg?: unknown) => void): () => void;
  /** The Start screen while the board is not up: the hub's module run by the app, without the board's own folders. */
  startLocal(want?: string): Promise<StartView>;
  shortPath(p: string): Promise<string>;
  chooseFolder(): Promise<string | null>;
  pathForFile(f: File): string;
  storeGet(): Promise<Record<string, unknown>>;
  storeSet(patch: Record<string, unknown>): void;
  openExternal(url: string): void;
  /** A page file, an item's file or a folder, in the person's own app (logged instead when offscreen). */
  openPath(p: string): void;
  copyText(text: string): void;
  /** The colour macOS shows where the window grows before the page is drawn there (a live resize). */
  windowBackground(color: string): void;
  /** System Settings > Notifications (Alerts, when macOS has not allowed Ravenry's). */
  openNotificationSettings(): void;
  /** A click on one of Ravenry's Mac notifications: the session it was about. */
  onNotifyOpen(fn: (n: { projectId: string | null; surfaceId: string | null; kind: string | null }) => void): void;
  /** The clipboard's text (a test's own text offscreen, never the real clipboard). */
  readClipboard(): Promise<string>;
  /** An update that stopped after 3 tries: try it again. */
  retryUpdate(): void;
  /** A hub call whose answer is read whatever its status. */
  hubCall(method: 'GET' | 'POST', p: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  focusWindow(): void;
  /** A line in the app's log (~/Library/Logs/Ravenry/app.log): what failed in the window. */
  log(line: string): void;
  /** The terminal's right-click menu, the system's own: the item picked, or null. */
  termMenu(info: { selection: boolean; link: string | null; cwd: string | null; split: boolean }): Promise<string | null>;
  /** The terminal settings (docs/SETTINGS.md). */
  settings: SettingsApi;
  /** The Ravenry skill per assistant (the hub's /api/setup/skills, through src/main/main.ts). */
  skills: SkillsApi;
}

declare global {
  interface Window { ravenry: RavenryApi }
}

export const api = (): RavenryApi => window.ravenry;
