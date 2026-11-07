// The terminal settings on disk: <userData>/settings.json, and the themes
// the person imported in <userData>/themes/. The shape, defaults, checks
// and migrations are in src/shared/settings.ts; the window and the IPC in
// src/main/settings.ts. No Electron here, so the tests use it as it is.

import fs from 'node:fs';
import path from 'node:path';
import { checkPatch, migrate, normalize, SETTINGS_VERSION } from '../shared/settings.ts';
import type { Settings } from '../shared/settings.ts';
import { BUILT_IN_THEMES, isThemeFile, slug } from '../shared/themes.ts';
import type { ThemeFile, ThemeInfo } from '../shared/themes.ts';
import { importTheme } from './themeimport.ts';

export type SetResult = { ok: true; settings: Settings } | { ok: false; error: string };
export type ImportThemeResult = { ok: true; theme: ThemeInfo } | { ok: false; error: string };

export class SettingsStore {
  readonly file: string;
  readonly themesDir: string;
  /** What was wrong with the file when it was read (each fixed with a default). */
  problems: string[] = [];
  private data: Settings;
  private userThemes: ThemeInfo[] = [];
  private listeners = new Set<(s: Settings) => void>();

  constructor(dir: string) {
    this.file = path.join(dir, 'settings.json');
    this.themesDir = path.join(dir, 'themes');
    this.data = this.load();
    this.userThemes = this.readThemes();
  }

  private load(): Settings {
    let text: string | null = null;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { /* none yet: the defaults */ }
    if (text === null) return normalize(undefined).settings;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      // Kept beside, never lost: the person may have been editing it.
      const keep = `${this.file}.broken`;
      try { fs.copyFileSync(this.file, keep); } catch { /* read-only */ }
      this.problems = [`settings.json is not JSON (${(e as Error).message}); kept as ${path.basename(keep)}, using the defaults`];
      return normalize(undefined).settings;
    }
    const m = migrate(raw);
    const n = normalize(m.data);
    this.problems = n.problems;
    if (m.newer) {
      // A newer app wrote it: a copy is kept before this one writes over it.
      const keep = path.join(path.dirname(this.file), `settings.v${m.from}.json`);
      if (!fs.existsSync(keep)) { try { fs.copyFileSync(this.file, keep); } catch { /* read-only */ } }
      this.problems.unshift(`settings.json is from a newer Ravenry (version ${m.from}); read what this version knows, the file kept as ${path.basename(keep)}`);
    } else if (m.from < SETTINGS_VERSION) {
      const keep = path.join(path.dirname(this.file), `settings.v${m.from}.json`);
      try { fs.copyFileSync(this.file, keep); } catch { /* read-only */ }
      this.data = n.settings;
      this.save();
    }
    return n.settings;
  }

  private readThemes(): ThemeInfo[] {
    let names: string[] = [];
    try { names = fs.readdirSync(this.themesDir).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
    const out: ThemeInfo[] = [];
    for (const f of names) {
      try {
        const t = JSON.parse(fs.readFileSync(path.join(this.themesDir, f), 'utf8'));
        if (isThemeFile(t)) out.push({ id: `user:${f.slice(0, -5)}`, builtIn: false, name: t.name, appearance: t.appearance, ...(t.credit ? { credit: t.credit } : {}), theme: t.theme });
        else this.problems.push(`themes/${f}: not a theme file; left out`);
      } catch { this.problems.push(`themes/${f}: not JSON; left out`); }
    }
    return out;
  }

  get(): Settings { return { ...this.data }; }

  /** The shipped themes, then the imported ones. */
  themes(): ThemeInfo[] { return [...BUILT_IN_THEMES, ...this.userThemes]; }

  /** A change: all of it or, when a value is wrong, none of it. */
  set(patch: unknown): SetResult {
    const c = checkPatch(patch, this.themes());
    if (!c.ok) return c;
    const next = { ...this.data, ...c.patch, version: SETTINGS_VERSION };
    if (Object.keys(c.patch).every((k) => (this.data as unknown as Record<string, unknown>)[k] === (next as unknown as Record<string, unknown>)[k])) return { ok: true, settings: this.get() };
    this.data = next;
    this.save();
    this.emit();
    return { ok: true, settings: this.get() };
  }

  /** A theme file's text (.itermcolors or Ghostty) saved as an imported theme. */
  importTheme(text: string, fileName: string): ImportThemeResult {
    const r = importTheme(text, fileName);
    if (!r.ok) return r;
    const same = this.userThemes.find((t) => t.name === r.theme.name && JSON.stringify(t.theme) === JSON.stringify(r.theme.theme));
    if (same) return { ok: true, theme: same };
    const base = slug(r.theme.name);
    let id = base;
    for (let n = 2; this.userThemes.some((t) => t.id === `user:${id}`) || fs.existsSync(path.join(this.themesDir, `${id}.json`)); n++) id = `${base.slice(0, 56)}-${n}`;
    const file: ThemeFile = r.theme;
    fs.mkdirSync(this.themesDir, { recursive: true });
    writeAtomic(path.join(this.themesDir, `${id}.json`), JSON.stringify(file, null, 2) + '\n');
    const info: ThemeInfo = { id: `user:${id}`, builtIn: false, ...file };
    this.userThemes.push(info);
    this.emit();
    return { ok: true, theme: info };
  }

  onChange(fn: (s: Settings) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void {
    for (const fn of this.listeners) { try { fn(this.get()); } catch (e) { console.error('settings listener:', e); } }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      writeAtomic(this.file, JSON.stringify(this.data, null, 2) + '\n');
    } catch (e) { console.error('settings.json:', (e as Error).message); }
  }
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}
