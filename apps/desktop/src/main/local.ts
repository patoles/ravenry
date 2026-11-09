// The app's own memory on this machine (window.json) and how it says a
// path. What the first-launch screen offers (folders that look like
// projects, the assistants found) is the hub's: hub/server/firstlaunch.mjs,
// GET /api/setup/start.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sayPath } from '../../../../hub/public/homepath.mjs';

export function shortPath(p: string, home: string = os.homedir()): string {
  return sayPath(p, home);
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
