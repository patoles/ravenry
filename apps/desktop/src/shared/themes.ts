// The terminal themes: the eight that ship with the app (shared/themes/*.json, each
// an xterm.js ITheme with a name), and helpers for themes the person
// imported (src/main/themeimport.ts). Pure: used by the main process, the
// Settings window and the tests.

import ravenryDark from '../../../../shared/themes/ravenry-dark.json' with { type: 'json' };
import ravenryLight from '../../../../shared/themes/ravenry-light.json' with { type: 'json' };
import solarizedDark from '../../../../shared/themes/solarized-dark.json' with { type: 'json' };
import solarizedLight from '../../../../shared/themes/solarized-light.json' with { type: 'json' };
import dracula from '../../../../shared/themes/dracula.json' with { type: 'json' };
import nord from '../../../../shared/themes/nord.json' with { type: 'json' };
import githubLight from '../../../../shared/themes/github-light.json' with { type: 'json' };
import paper from '../../../../shared/themes/paper.json' with { type: 'json' };
import spec from '../../../../shared/settings/settings.json' with { type: 'json' };

/** xterm.js's ITheme, as plain JSON (every field a CSS colour). */
export interface XtermTheme {
  background: string; foreground: string; cursor: string; cursorAccent: string;
  selectionBackground?: string; selectionForeground?: string;
  scrollbarSliderBackground?: string; scrollbarSliderHoverBackground?: string; scrollbarSliderActiveBackground?: string;
  black: string; red: string; green: string; yellow: string; blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}

export type Appearance = 'dark' | 'light';

/** A theme file: built in (shared/themes) or imported (<userData>/themes). */
export interface ThemeFile { name: string; appearance: Appearance; credit?: string; theme: XtermTheme }

/** A theme as the API lists it. Built-in ids are plain, imported ones start with "user:". */
export interface ThemeInfo extends ThemeFile { id: string; builtIn: boolean }

export const ANSI_KEYS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const;

const FILES: Record<string, ThemeFile> = {
  'ravenry-dark': ravenryDark as ThemeFile,
  'solarized-dark': solarizedDark as ThemeFile,
  dracula: dracula as ThemeFile,
  nord: nord as ThemeFile,
  'ravenry-light': ravenryLight as ThemeFile,
  'solarized-light': solarizedLight as ThemeFile,
  'github-light': githubLight as ThemeFile,
  paper: paper as ThemeFile,
};

/** The shipped themes, in the order the Settings window shows them (dark first; shared/settings/settings.json themes). */
export const BUILT_IN_THEMES: ThemeInfo[] = spec.themes.map((id) => ({ id, builtIn: true, ...FILES[id] }));

export const DEFAULT_DARK_THEME: string = spec.defaultDarkTheme;
export const DEFAULT_LIGHT_THEME: string = spec.defaultLightTheme;

/** "#abc", "#aabbcc" or "#aabbccdd" to [r, g, b] (0 to 255), else null. */
export function parseHex(c: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(c.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((x) => x + x).join('');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export const toHex = (rgb: readonly number[]): string =>
  '#' + rgb.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();

/** Dark or light, from the background's relative luminance. */
export function appearanceOf(background: string): Appearance {
  const rgb = parseHex(background);
  if (!rgb) return 'dark';
  const lin = rgb.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  const l = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return l > 0.4 ? 'light' : 'dark';
}

const CSS_COLOUR = /^(#[0-9a-f]{3}|#[0-9a-f]{6}|#[0-9a-f]{8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/i;

/** Whether a value is a theme file this app can use (every required colour present and a CSS colour). */
export function isThemeFile(v: unknown): v is ThemeFile {
  if (!v || typeof v !== 'object') return false;
  const f = v as ThemeFile;
  if (typeof f.name !== 'string' || !f.name.trim() || (f.appearance !== 'dark' && f.appearance !== 'light')) return false;
  if (!f.theme || typeof f.theme !== 'object') return false;
  const t = f.theme as unknown as Record<string, unknown>;
  for (const k of ['background', 'foreground', 'cursor', 'cursorAccent', ...ANSI_KEYS]) {
    if (typeof t[k] !== 'string' || !CSS_COLOUR.test(t[k] as string)) return false;
  }
  for (const c of Object.values(t)) if (typeof c !== 'string' || !CSS_COLOUR.test(c)) return false;
  return true;
}

/** A theme name made into a file and id slug: "Tokyo Night (Storm)" is "tokyo-night-storm". */
export function slug(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'theme';
}
