// What the first-launch screen (Start a session) offers on this machine:
// folders that look like projects, and which assistants are installed and
// signed in. Read only. Node built-ins and public/homepath.mjs only, and no
// import of home.mjs, so the desktop app can run it in process while the
// board is not up yet (its one fallback, docs/FEATURES.md SES-001's notes).
//
// GET /api/setup/start[?folder=<absolute path>] answers startView():
//
//   {
//     ok: true,
//     root: "~/code" | null,          // the project root the scan found them in
//     folders: [{ name, path, short }],  // at most 5: the folders the board
//                                     // knows first (registered projects,
//                                     // most recently active first), then
//                                     // the scan's, newest first; `folder`
//                                     // asked for comes first when missing
//     assistants: [{ kind: "claude" | "codex", name, found, signedIn,
//                    path: string | null }]   // always both, in that order
//   }
//
// `short` is the path as people read it ("~/code/app", sayPath). A client
// draws the list as sent and preselects the first folder, and the first
// assistant found and signed in (else the first found).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sayPath } from '../public/homepath.mjs';

const ROOTS = ['code', 'Code', 'Projects', 'projects', 'Developer', 'dev', 'src', 'repos', 'git', 'work'];
const MARKERS = ['.git', 'package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'README.md'];

/**
 * Folders that look like projects (they hold a .git or a package file), from
 * the first of the usual project roots that has any, newest first.
 */
export function findProjectFolders(home = os.homedir(), max = 5, root) {
  const roots = root ? [root] : ROOTS.map((r) => path.join(home, r));
  for (const r of roots) {
    let names;
    try { names = fs.readdirSync(r); } catch { continue; }
    const found = [];
    for (const n of names) {
      if (n.startsWith('.')) continue;
      const p = path.join(r, n);
      try {
        const st = fs.statSync(p);
        if (!st.isDirectory()) continue;
        if (!MARKERS.some((m) => fs.existsSync(path.join(p, m)))) continue;
        found.push({ p, t: st.mtimeMs });
      } catch { /* unreadable */ }
    }
    if (!found.length) continue;
    found.sort((a, b) => b.t - a.t);
    return { root: r, folders: found.slice(0, max).map((f) => ({ name: path.basename(f.p), path: f.p, short: sayPath(f.p, home) })) };
  }
  return { root: null, folders: [] };
}

function onPath(bin, env, home) {
  // A Mac app started from the Finder gets a short PATH, and so may the
  // board's service, so the usual install folders are looked at too.
  const dirs = [...(env.PATH || '').split(path.delimiter), path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin')];
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

/** Claude Code and Codex: installed (on the PATH or the usual folders) and signed in (their own login files exist). */
export function findAssistants(env = process.env, home = os.homedir()) {
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

/**
 * The Start screen's answer. `known`: the board's own folders (absolute
 * paths, most recently active first); `want`: a folder the client asked
 * to start in (a project's), first among the picks.
 */
export function startView({ home = os.homedir(), env = process.env, known = [], want = null, max = 5 } = {}) {
  const found = findProjectFolders(home, max);
  const pick = (p) => ({ name: path.basename(p) || p, path: p, short: sayPath(p, home) });
  const kn = [];
  for (const k of known) if (typeof k === 'string' && k && !kn.some((x) => x.path === k)) kn.push(pick(k));
  let folders = [...kn, ...found.folders.filter((f) => !kn.some((k) => k.path === f.path))].slice(0, max);
  if (typeof want === 'string' && path.isAbsolute(want) && !folders.some((f) => f.path === want)) folders = [pick(want), ...folders].slice(0, max);
  return { root: found.root ? sayPath(found.root, home) : null, folders, assistants: findAssistants(env, home) };
}
