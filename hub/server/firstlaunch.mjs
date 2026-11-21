// What the first-launch screen (Start a session) offers on this machine:
// folders that look like projects, and which assistants are installed and
// signed in. Read only. Node built-ins, public/homepath.mjs and the assistant
// registry (server/assistants.mjs, built-ins too) only, and no
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
//     assistants: [{ kind, name, found, signedIn, path: string | null,
//                    ...the registry's view of it }]   // every registered
//                                     // one, in the registry's order
//                                     // (server/assistants.mjs): Claude
//                                     // Code, then Codex
//   }
//
// `short` is the path as people read it ("~/code/app", sayPath). A client
// draws the list as sent and preselects the first folder, and the first
// assistant found and signed in (else the first found).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sayPath } from '../public/homepath.mjs';
import * as registry from './assistants.mjs';
import { findBin, signedIn } from './assistantfind.mjs';

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

/** Every registered assistant (server/assistants.mjs): installed (on the PATH or the usual folders) and signed in (its key, or its own login file). */
export function findAssistants(env = process.env, home = os.homedir()) {
  return registry.IDS.map((kind) => {
    const p = findBin(kind, env, home);
    return { ...registry.view(kind), kind, name: registry.nameOf(kind), found: !!p, signedIn: !!p && signedIn(kind, env, home), path: p };
  });
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
