// How the app starts ravenryd when none runs: which binary, and with what
// environment. No Electron here, so tests import it.

import fs from 'node:fs';
import path from 'node:path';

/** The environment a daemon started by the app gets (its panes inherit it). */
export function daemonEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    // Electron's own variables would change how programs in the panes run.
    if (k.startsWith('ELECTRON_') || k === 'NODE_OPTIONS' || k === 'GOOGLE_API_KEY' || k.startsWith('CHROME_')) continue;
    out[k] = v;
  }
  return out;
}

/**
 * The ravenryd binary to start when none runs: RAVENRYD, then the packaged
 * app's copy of its own (install.ts, stageVersion), then the one in the
 * app's resources, then the repo's daemon/ravenryd (a dev build), then the
 * PATH.
 */
export function daemonBinary(appRoot: string, env: NodeJS.ProcessEnv = process.env, staged?: string | null): string | null {
  const exe = process.platform === 'win32' ? 'ravenryd.exe' : 'ravenryd';
  const candidates = [
    env.RAVENRYD,
    staged || undefined,
    process.resourcesPath ? path.join(process.resourcesPath, exe) : undefined,
    path.resolve(appRoot, '..', '..', 'daemon', exe),
    ...(env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe)),
  ];
  for (const c of candidates) {
    if (!c) continue;
    try { fs.accessSync(c, fs.constants.X_OK); if (fs.statSync(c).isFile()) return c; } catch { /* next */ }
  }
  return null;
}
