// Types of firstlaunch.mjs, for the desktop app (its fallback while the board is not up).
export interface FolderPick { name: string; path: string; short: string }
export interface AssistantInfo { kind: 'claude' | 'codex'; name: string; found: boolean; signedIn: boolean; path: string | null }
export interface StartView { root: string | null; folders: FolderPick[]; assistants: AssistantInfo[] }
type Env = Record<string, string | undefined>;
export function findProjectFolders(home?: string, max?: number, root?: string): { root: string | null; folders: FolderPick[] };
export function findAssistants(env?: Env, home?: string): AssistantInfo[];
export function startView(o?: { home?: string; env?: Env; known?: string[]; want?: string | null; max?: number }): StartView;
