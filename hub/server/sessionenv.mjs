// The PATH each session ran with, so a session the board starts for it
// later (a hand-off's fresh session, a New session) runs its assistant as
// a program of the new tab, by its absolute path and with that PATH,
// instead of typing a command into a shell whose startup files may ask
// something first (server/launch.mjs). A PATH set only in ~/.zshrc (nvm,
// a folder of the person's own) reaches the board this way: the session
// ran in a shell that read it.
//
// hooks/events.mjs writes <RAVENRY_HOME>/sessionenv/<session id>.json at
// each SessionStart, also in a ravenryd pane (where the daemon reports the
// events): { at, assistant, path }. Files older than PRUNE_DAYS go at the
// next SessionStart. Node built-ins only: the hook loads this on every
// SessionStart.

import fs from 'node:fs';
import path from 'node:path';

const SAFE_ID = /^[A-Za-z0-9_-]{6,80}$/;
const PRUNE_DAYS = 14;
const dirOf = (home) => path.join(home, 'sessionenv');

// The hook's half: one session's PATH (from the assistant's own
// environment, which the hook inherits).
export function write(home, sessionId, { assistant = 'claude', PATH = '' } = {}) {
  if (!home || !SAFE_ID.test(String(sessionId || '')) || !PATH) return false;
  const dir = dirOf(home);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, sessionId + '.json');
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), assistant: String(assistant || 'claude'), path: String(PATH).slice(0, 8192) }));
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

export function prune(home, now = Date.now()) {
  const dir = dirOf(home);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const f of names) {
    const p = path.join(dir, f);
    try { if (fs.statSync(p).mtimeMs < now - PRUNE_DAYS * 86400000) fs.unlinkSync(p); } catch { /* raced */ }
  }
}

// One session's record, or null.
export function read(home, sessionId) {
  if (!home || !SAFE_ID.test(String(sessionId || ''))) return null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dirOf(home), sessionId + '.json'), 'utf8'));
    return j && typeof j.path === 'string' && j.path ? j : null;
  } catch { return null; }
}

// The newest record of an assistant (any session), for a start with no
// session before it (New session), or null.
export function newest(home, assistant = 'claude') {
  let names = [];
  try { names = fs.readdirSync(dirOf(home)).filter((f) => f.endsWith('.json')); } catch { return null; }
  let best = null;
  for (const f of names) {
    const j = read(home, f.slice(0, -5));
    if (j && (j.assistant || 'claude') === assistant && (!best || String(j.at) > String(best.at))) best = j;
  }
  return best;
}
