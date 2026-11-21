// The Ravenry skill as the windows see it (the hub's hub/server/skills.mjs does the work).

export interface SkillRow {
  /** The assistant's id in the hub's registry (claude, codex, ...). */
  kind: string;
  name: string;
  /** The assistant is installed on this machine. */
  found: boolean;
  dir: string;
  installed: boolean;
  /** Ravenry wrote it (Remove takes it out). */
  ours: boolean;
  version: string | null;
  /** Its hooks tell Ravenry when it needs you: on, off, or unavailable (no board, or not here). */
  hooks: 'on' | 'off' | 'unavailable';
  hooksFile: string | null;
}

export interface SkillsApi {
  get(): Promise<SkillRow[]>;
  set(kind: string, on: boolean): Promise<{ ok: true; skills: SkillRow[] } | { ok: false; error: string }>;
  setHooks(kind: string, on: boolean): Promise<{ ok: true; skills: SkillRow[] } | { ok: false; error: string }>;
  onChange(cb: (rows: SkillRow[]) => void): () => void;
}
