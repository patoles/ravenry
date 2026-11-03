// What the iTerm2 adapter needs beyond AppleScript, checked and set up:
// iTerm2's Python API switch, and a Python with iTerm2's `iterm2` package
// for the arrow keys (server/iterm-keys.py). The package goes in a private
// venv at ~/.ravenry/iterm2-py, made only when asked (`ravenry setup` in
// iTerm2, or tools/install-iterm.mjs). Without it everything else works;
// only choosing a menu option from the board does not.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { VENV_PYTHON, pythonBin } from './iterm.mjs';

export const VENV = path.dirname(path.dirname(VENV_PYTHON));
const ITERM_ID = 'com.googlecode.iterm2';

const run = (bin, args, timeout = 120000) => execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout });
const ok = (bin, args) => { try { run(bin, args, 20000); return true; } catch { return false; } };

export function imports(py) { return !!py && ok(py, ['-I', '-c', 'import iterm2']); }

// { ready, python }: a Python that imports iterm2, or the one found that does not.
export function helperState() {
  const py = pythonBin();
  return { ready: imports(py), python: py };
}

// iTerm2 > Settings > General > Magic > Enable Python API, read from its
// settings so iTerm2 is never asked.
export function apiOn() {
  try { return run('/usr/bin/defaults', ['read', ITERM_ID, 'EnableAPIServer'], 5000).trim() === '1'; } catch { return false; }
}

// macOS's /usr/bin/python3 is a stub that opens the Command Line Tools
// installer when they are missing, so it is only run when they are there.
export function hasPython3() {
  if (!ok('/usr/bin/xcode-select', ['-p'])) return false;
  return ok('/usr/bin/python3', ['-c', 'import venv']);
}

// Makes the venv and installs iterm2. Returns { ok, python } or { ok: false, error }.
export function makeHelper(log = () => {}) {
  try {
    if (!fs.existsSync(VENV_PYTHON)) {
      if (!hasPython3()) return { ok: false, error: "Python 3 is not on this Mac (it comes with Apple's Command Line Tools: xcode-select --install)." };
      log(`Making a Python venv at ${VENV}`);
      fs.mkdirSync(path.dirname(VENV), { recursive: true });
      run('/usr/bin/python3', ['-m', 'venv', VENV]);
    }
    log('Installing the iterm2 package');
    run(VENV_PYTHON, ['-m', 'pip', 'install', '-q', '--disable-pip-version-check', 'iterm2'], 300000);
  } catch (e) {
    return { ok: false, error: String((e.stderr || e.message || e)).trim().split('\n').pop() };
  }
  return imports(VENV_PYTHON) ? { ok: true, python: VENV_PYTHON } : { ok: false, error: `${VENV_PYTHON} still does not import iterm2.` };
}
