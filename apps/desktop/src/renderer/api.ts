// window.ravenry, as the preload script exposes it.

export interface AppConfig {
  platform: string;
  hubUrl: string;
  newShell: string[] | null;
  home: string;
  offscreen: boolean;
  /** The ravenryd the hook setup points the assistants' hooks at, or null (no setup offered). */
  hookBin: string | null;
}

export interface HubStatus { reachable: boolean; url: string; error?: string }
export interface FolderPick { name: string; path: string; short: string }
export interface AssistantInfo { kind: 'claude' | 'codex'; name: string; found: boolean; signedIn: boolean; path: string | null }

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
  folders(root?: string): Promise<{ root: string | null; folders: FolderPick[] }>;
  assistants(): Promise<AssistantInfo[]>;
  shortPath(p: string): Promise<string>;
  chooseFolder(): Promise<string | null>;
  pathForFile(f: File): string;
  storeGet(): Promise<Record<string, unknown>>;
  storeSet(patch: Record<string, unknown>): void;
  openExternal(url: string): void;
  focusWindow(): void;
}

declare global {
  interface Window { ravenry: RavenryApi }
}

export const api = (): RavenryApi => window.ravenry;
