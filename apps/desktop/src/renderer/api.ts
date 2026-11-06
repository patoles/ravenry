// window.ravenry, as the preload script exposes it.

export interface AppConfig {
  platform: string;
  hubUrl: string;
  newShell: string[] | null;
  home: string;
  offscreen: boolean;
}

export interface HubStatus { reachable: boolean; url: string; error?: string }
export interface FolderPick { name: string; path: string; short: string }
export interface AssistantInfo { kind: 'claude' | 'codex'; name: string; found: boolean; signedIn: boolean; path: string | null }

export interface RavenryApi {
  config(): Promise<AppConfig>;
  connectDaemon(req: number, socket?: string): void;
  resetDaemon(): void;
  hubState(): Promise<{ state: unknown; status: HubStatus | null }>;
  hubGet(p: string): Promise<unknown>;
  hubPost(p: string, body: unknown): Promise<unknown>;
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
}

declare global {
  interface Window { ravenry: RavenryApi }
}

export const api = (): RavenryApi => window.ravenry;
