// Finding a registered assistant (server/assistants.mjs) on this machine:
// its binary on the PATH or where its installer puts it, its login, its own
// folder and where the Ravenry skill goes for it. Node built-ins only and
// no import of home.mjs: server/firstlaunch.mjs reads it, and the desktop
// app runs that in process while the board is not up.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as registry from './assistants.mjs';

/** The assistant's own folder (~/.claude, CODEX_HOME, OpenCode's ~/.config/opencode). */
export function homeDir(k, env = process.env, home = os.homedir()) {
  const a = registry.of(k);
  if (a.home.env && env[a.home.env]) return env[a.home.env];
  if (a.home.xdg && env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)) return path.join(env.XDG_CONFIG_HOME, a.home.xdg);
  return path.join(home, a.home.dir);
}

/** Where the Ravenry skill goes for it, or null when it takes none. */
export function skillDir(k, env = process.env, home = os.homedir()) {
  const a = registry.of(k);
  return a.skill ? path.join(homeDir(k, env, home), a.skill) : null;
}

/** Its binary on the PATH or in the usual install folders, or null. */
export function findBin(k, env = process.env, home = os.homedir()) {
  // A Mac app started from the Finder gets a short PATH, and so may the
  // board's service, so the usual install folders are looked at too.
  const dirs = [...(env.PATH || '').split(path.delimiter), path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin'), path.join(home, '.opencode', 'bin')];
  const bin = registry.of(k).bin;
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

/** Signed in: its key in the environment, its login file, or its login keychain item. True when it has nothing to sign in to. */
export function signedIn(k, env = process.env, home = os.homedir()) {
  const s = registry.of(k).signIn;
  if (!s) return true;
  if ((s.env || []).some((v) => !!env[v])) return true;
  if (s.keychain) return inKeychain(s.keychain, home);
  if (!s.file) return false;
  const f = s.file.startsWith('~/') ? path.join(home, s.file.slice(2)) : path.join(homeDir(k, env, home), s.file);
  try {
    if (!s.match) return fs.existsSync(f);
    return new RegExp(s.match).test(fs.readFileSync(f, 'utf8'));
  } catch { return false; }
}


// Whether a login keychain item is there (Antigravity CLI keeps its Google
// sign-in in one: service "gemini", account "antigravity", written through
// /usr/bin/security). Asked of `security find-generic-password` without -w,
// so the secret is never read and no keychain dialog opens; the keychain is
// the one under `home` (a test's scratch HOME links its Library/Keychains).
// Kept a minute: New session asks on every open.
const keychainSeen = new Map();
export function inKeychain({ service, account }, home = os.homedir()) {
  if (process.platform !== 'darwin') return false;
  const key = `${home}\n${service}\n${account}`;
  const hit = keychainSeen.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.value;
  let value = false;
  try {
    const r = spawnSync('/usr/bin/security', ['find-generic-password', '-s', service, ...(account ? ['-a', account] : [])], { env: { HOME: home, PATH: '/usr/bin:/bin' }, stdio: 'ignore', timeout: 3000 });
    value = r.status === 0;
  } catch { value = false; }
  keychainSeen.set(key, { at: Date.now(), value });
  return value;
}
