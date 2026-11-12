// An app brought forward by its bundle id (`open -b`), on the Mac only: the
// cmux app when cmux refuses its socket (index.mjs), the Rex app after Open
// in Rex showed the session there (rex.mjs focus). MC_OPEN_COMMAND (JSON
// argv, `-b <bundle>` appended) replaces `open` in tests; a test board
// (RAVENRY_HOME or MC_HOME set) never runs the real `open` without
// MC_OPEN_REAL=1, so no test brings an app forward on the person's screen.

import { execFile } from 'node:child_process';
import { HOME_OVERRIDE } from './home.mjs';

export function openApp(bundle) {
  const stub = process.env.MC_OPEN_COMMAND ? JSON.parse(process.env.MC_OPEN_COMMAND) : null;
  if (!stub && HOME_OVERRIDE && process.env.MC_OPEN_REAL !== '1') return Promise.resolve({ ok: false, status: 503, error: 'A test board does not open apps. Set MC_OPEN_COMMAND or MC_OPEN_REAL=1.' });
  const [cmd, ...args] = stub || ['/usr/bin/open'];
  return new Promise((resolve) => {
    execFile(cmd, [...args, '-b', bundle], { timeout: 10000 }, (err, _out, stderr) => {
      resolve(err ? { ok: false, status: 500, error: `It did not open: ${(String(stderr || '').trim().split('\n').pop() || err.message).slice(0, 160)}` } : { ok: true });
    });
  });
}
