// What the first-launch screen needs from this machine: folders that look
// like projects, and which assistants are installed and signed in. Read
// only; nothing here writes outside the app's own data folder.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sayPath } from '../../../../hub/public/homepath.mjs';

export interface FolderPick { name: string; path: string; short: string }

export function shortPath(p: string, home: string = os.homedir()): string {
  return sayPath(p, home);
}

const ROOTS = ['code', 'Code', 'Projects', 'projects', 'Developer', 'dev', 'src', 'repos', 'git', 'work'];

/**
 * Folders that look like projects (they hold a .git or a package file), from
 * the first of the usual project roots that has any, newest first.
 */
export function findProjectFolders(home: string = os.homedir(), max = 5, root?: string): { root: string | null; folders: FolderPick[] } {
  const roots = root ? [root] : ROOTS.map((r) => path.join(home, r));
  for (const r of roots) {
    let names: string[];
    try { names = fs.readdirSync(r); } catch { continue; }
    const found: { p: string; t: number }[] = [];
    for (const n of names) {
      if (n.startsWith('.')) continue;
      const p = path.join(r, n);
      try {
        const st = fs.statSync(p);
        if (!st.isDirectory()) continue;
        if (!['.git', 'package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'README.md'].some((m) => fs.existsSync(path.join(p, m)))) continue;
        found.push({ p, t: st.mtimeMs });
      } catch { /* unreadable */ }
    }
    if (!found.length) continue;
    found.sort((a, b) => b.t - a.t);
    return { root: r, folders: found.slice(0, max).map((f) => ({ name: path.basename(f.p), path: f.p, short: shortPath(f.p, home) })) };
  }
  return { root: null, folders: [] };
}

export interface AssistantInfo { kind: 'claude' | 'codex'; name: string; found: boolean; signedIn: boolean; path: string | null }

function onPath(bin: string, env: NodeJS.ProcessEnv, home: string): string | null {
  // A Mac app started from the Finder gets a short PATH, so the usual
  // install folders are looked at too.
  const dirs = [...(env.PATH || '').split(path.delimiter), path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin')];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

/** Claude Code and Codex: installed (on the PATH or the usual folders) and signed in (their own login files exist). */
export function findAssistants(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): AssistantInfo[] {
  const claude = onPath('claude', env, home);
  const codex = onPath('codex', env, home);
  let claudeIn = !!env.ANTHROPIC_API_KEY;
  try { claudeIn = claudeIn || /"oauthAccount"\s*:\s*\{/.test(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')); } catch { /* none */ }
  const codexHome = env.CODEX_HOME || path.join(home, '.codex');
  const codexIn = !!env.OPENAI_API_KEY || fs.existsSync(path.join(codexHome, 'auth.json'));
  return [
    { kind: 'claude', name: 'Claude Code', found: !!claude, signedIn: !!claude && claudeIn, path: claude },
    { kind: 'codex', name: 'Codex', found: !!codex, signedIn: !!codex && codexIn, path: codex },
  ];
}

/** The window's own memory: its tabs (pane ids and pinned sessions) and the panel's state, in the app's data folder. */
export class Store {
  file: string;
  data: Record<string, unknown>;
  private timer: NodeJS.Timeout | null = null;

  constructor(dir: string) {
    this.file = path.join(dir, 'window.json');
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = {}; }
  }

  get(): Record<string, unknown> { return this.data; }

  set(patch: Record<string, unknown>): void {
    this.data = { ...this.data, ...patch };
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 200);
  }

  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n');
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('window.json:', (e as Error).message); }
  }
}
