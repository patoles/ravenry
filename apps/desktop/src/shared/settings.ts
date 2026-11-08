// The terminal settings: their shape, defaults, checks and migrations, and
// what they make of the terminal (xterm.js options). Pure: the main
// process's store (src/main/settings.ts), the Settings window and the
// main window all use it. The API is in docs/SETTINGS.md.

import { BUILT_IN_THEMES, DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME } from './themes.ts';
import type { Appearance, ThemeInfo, XtermTheme } from './themes.ts';

export const SETTINGS_VERSION = 1;

export type CursorStyle = 'block' | 'bar' | 'underline';
export type OptionAsMeta = 'off' | 'left' | 'right' | 'both';
export type Bell = 'visual' | 'sound' | 'off';

export interface Settings {
  version: number;
  /** A font family name, as the system lists it. */
  fontFamily: string;
  fontSize: number;
  /** Use themeLight when the system is light and themeDark when it is dark; off: themeAlways. */
  themeFollowsSystem: boolean;
  themeDark: string;
  themeLight: string;
  themeAlways: string;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  /** Which Option key sends Esc+key (xterm.js's macOptionIsMeta, per key). */
  optionAsMeta: OptionAsMeta;
  copyOnSelect: boolean;
  /** A link in a terminal opens on a plain click, not only Cmd+click (Ctrl+click off the Mac). */
  openLinksSingleClick: boolean;
  /** Lines of scrollback. */
  scrollback: number;
  bell: Bell;
  /** Bounce the Dock icon on a bell while Ravenry is not the front app (macOS). */
  bellBounceDock: boolean;
  /** Ask before closing a tab whose shell runs something. */
  confirmCloseBusy: boolean;
}

/** The settings a person can change: everything but the version. */
export type SettingsPatch = Partial<Omit<Settings, 'version'>>;

export const DEFAULT_FONT = 'Menlo';
export const FONT_FALLBACK = ['Menlo', 'SF Mono', 'DejaVu Sans Mono', 'Liberation Mono'];
export const FONT_SIZE = { min: 8, max: 32 };
export const SCROLLBACK = { min: 100, max: 100000 };

export const DEFAULTS: Settings = {
  version: SETTINGS_VERSION,
  fontFamily: DEFAULT_FONT,
  fontSize: 13,
  themeFollowsSystem: true,
  themeDark: DEFAULT_DARK_THEME,
  themeLight: DEFAULT_LIGHT_THEME,
  themeAlways: DEFAULT_DARK_THEME,
  cursorStyle: 'block',
  cursorBlink: false,
  // Off, as before settings existed: Option types the keyboard's
  // characters ({ } | ~ [ ] on a French keyboard).
  optionAsMeta: 'off',
  copyOnSelect: false,
  // Cmd+click, the Mac's way; a plain click selects text, as in iTerm2.
  openLinksSingleClick: false,
  scrollback: 10000,
  bell: 'visual',
  bellBounceDock: true,
  confirmCloseBusy: true,
};

const oneOf = <T extends string>(...vals: T[]) => (v: unknown): v is T => typeof v === 'string' && (vals as string[]).includes(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const intIn = (r: { min: number; max: number }) => (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= r.min && v <= r.max;
const themeId = (v: unknown): v is string => typeof v === 'string' && /^(user:)?[a-z0-9][a-z0-9-]{0,59}$/.test(v);
// A family name: no quotes, commas or control characters (it goes into a CSS font list).
const family = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 100 && !/["',;{}\\\u0000-\u001f]/.test(v);

/** Each setting's check, and what it says when a value fails it. */
const FIELDS: { [K in keyof SettingsPatch]-?: { ok: (v: unknown) => boolean; want: string } } = {
  fontFamily: { ok: family, want: 'a font family name' },
  fontSize: { ok: intIn(FONT_SIZE), want: `a whole number from ${FONT_SIZE.min} to ${FONT_SIZE.max}` },
  themeFollowsSystem: { ok: isBool, want: 'true or false' },
  themeDark: { ok: themeId, want: 'a theme id' },
  themeLight: { ok: themeId, want: 'a theme id' },
  themeAlways: { ok: themeId, want: 'a theme id' },
  cursorStyle: { ok: oneOf('block', 'bar', 'underline'), want: 'block, bar or underline' },
  cursorBlink: { ok: isBool, want: 'true or false' },
  optionAsMeta: { ok: oneOf('off', 'left', 'right', 'both'), want: 'off, left, right or both' },
  copyOnSelect: { ok: isBool, want: 'true or false' },
  openLinksSingleClick: { ok: isBool, want: 'true or false' },
  scrollback: { ok: intIn(SCROLLBACK), want: `a whole number from ${SCROLLBACK.min} to ${SCROLLBACK.max}` },
  bell: { ok: oneOf('visual', 'sound', 'off'), want: 'visual, sound or off' },
  bellBounceDock: { ok: isBool, want: 'true or false' },
  confirmCloseBusy: { ok: isBool, want: 'true or false' },
};

export const SETTING_KEYS = Object.keys(FIELDS) as (keyof SettingsPatch)[];

/**
 * A settings file's contents made whole: each missing or wrong value
 * becomes its default, and each wrong one is named in `problems`. Unknown
 * keys are dropped (named too).
 */
export function normalize(raw: unknown): { settings: Settings; problems: string[] } {
  const problems: string[] = [];
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  if (raw !== undefined && src !== raw) problems.push('the file is not an object; using the defaults');
  const out: Settings = { ...DEFAULTS };
  for (const k of SETTING_KEYS) {
    if (!(k in src)) continue;
    if (FIELDS[k].ok(src[k])) (out as unknown as Record<string, unknown>)[k] = src[k];
    else problems.push(`${k}: ${JSON.stringify(src[k])} is not ${FIELDS[k].want}; using ${JSON.stringify(DEFAULTS[k])}`);
  }
  for (const k of Object.keys(src)) if (k !== 'version' && !(k in FIELDS)) problems.push(`${k}: not a setting; dropped`);
  return { settings: out, problems };
}

/**
 * A change from the window: every key must be a setting and every value
 * right, else nothing changes. Theme ids must name a theme in `themes`.
 */
export function checkPatch(patch: unknown, themes: readonly { id: string }[]): { ok: true; patch: SettingsPatch } | { ok: false; error: string } {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'a change is an object of settings' };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    const f = FIELDS[k as keyof SettingsPatch];
    if (!f) return { ok: false, error: `${k} is not a setting` };
    if (!f.ok(v)) return { ok: false, error: `${k}: ${JSON.stringify(v)} is not ${f.want}` };
    if ((k === 'themeDark' || k === 'themeLight' || k === 'themeAlways') && !themes.some((t) => t.id === v)) return { ok: false, error: `${k}: there is no theme ${JSON.stringify(v)}` };
    out[k] = typeof v === 'string' && k === 'fontFamily' ? v.trim() : v;
  }
  return { ok: true, patch: out as SettingsPatch };
}

// ------------------------------------------------------------ migrations

/**
 * Each step takes a file of version i (the index) to version i + 1. Version
 * 0 is a file without a version: the first hand-written ones used
 * xterm.js's own option names (macOptionIsMeta, bellStyle, theme), which
 * this step turns into Ravenry's.
 */
export const MIGRATIONS: ((o: Record<string, unknown>) => Record<string, unknown>)[] = [
  (o) => {
    const n: Record<string, unknown> = { ...o };
    if ('macOptionIsMeta' in n) { if (!('optionAsMeta' in n)) n.optionAsMeta = n.macOptionIsMeta === true ? 'both' : 'off'; delete n.macOptionIsMeta; }
    if ('bellStyle' in n) {
      const b = n.bellStyle;
      if (!('bell' in n)) n.bell = b === 'none' ? 'off' : b === 'sound' ? 'sound' : 'visual';
      delete n.bellStyle;
    }
    if (typeof n.theme === 'string') {
      if (!('themeAlways' in n)) { n.themeAlways = n.theme; n.themeFollowsSystem = false; }
      delete n.theme;
    }
    if (typeof n.fontFamily === 'string') {
      // A CSS font list: its first family.
      n.fontFamily = n.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
    }
    n.version = 1;
    return n;
  },
];

/**
 * A file's contents brought to SETTINGS_VERSION. `from` is the version it
 * had; a file from a newer app is read as it is (`newer`), its unknown
 * keys dropped by normalize.
 */
export function migrate(raw: unknown): { data: unknown; from: number; newer: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { data: raw, from: SETTINGS_VERSION, newer: false };
  let o = raw as Record<string, unknown>;
  const v = o.version === undefined ? 0 : o.version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return { data: o, from: SETTINGS_VERSION, newer: false };
  if (v > SETTINGS_VERSION) return { data: o, from: v, newer: true };
  for (let i = v; i < SETTINGS_VERSION; i++) o = MIGRATIONS[i](o);
  return { data: o, from: v, newer: false };
}

// ------------------------------------------------------------ the terminal

/** What the settings make of a terminal (docs/SETTINGS.md, Applying them). */
export interface TerminalSettings {
  /** The system appearance this was worked out for. */
  appearance: Appearance;
  /** The theme in use and its name. */
  themeId: string;
  themeName: string;
  /** Options to set on each xterm.js Terminal as they are (term.options[k] = v). */
  xterm: {
    fontFamily: string;
    fontSize: number;
    cursorStyle: CursorStyle;
    cursorBlink: boolean;
    scrollback: number;
    /** True only for "both"; for left or right see macOptionIsMetaFor. */
    macOptionIsMeta: boolean;
    theme: XtermTheme;
  };
  optionAsMeta: OptionAsMeta;
  copyOnSelect: boolean;
  openLinksSingleClick: boolean;
  bell: Bell;
  bellBounceDock: boolean;
  confirmCloseBusy: boolean;
}

/** A family as the first of a CSS font list, then today's fallbacks. */
export function fontStack(name: string): string {
  const fams = [name, ...FONT_FALLBACK.filter((f) => f !== name)];
  return [...fams.map((f) => `"${f}"`), 'monospace'].join(', ');
}

/** The theme the settings pick for a system appearance (a missing one falls back to Ravenry's). */
export function pickTheme(s: Settings, themes: readonly ThemeInfo[], appearance: Appearance): ThemeInfo {
  const id = s.themeFollowsSystem ? (appearance === 'dark' ? s.themeDark : s.themeLight) : s.themeAlways;
  const fallback = appearance === 'dark' || !s.themeFollowsSystem ? DEFAULT_DARK_THEME : DEFAULT_LIGHT_THEME;
  return themes.find((t) => t.id === id) || BUILT_IN_THEMES.find((t) => t.id === fallback)!;
}

export function terminalSettings(s: Settings, themes: readonly ThemeInfo[], appearance: Appearance): TerminalSettings {
  const t = pickTheme(s, themes, appearance);
  return {
    appearance,
    themeId: t.id,
    themeName: t.name,
    xterm: {
      fontFamily: fontStack(s.fontFamily),
      fontSize: s.fontSize,
      cursorStyle: s.cursorStyle,
      cursorBlink: s.cursorBlink,
      scrollback: s.scrollback,
      macOptionIsMeta: s.optionAsMeta === 'both',
      theme: { ...t.theme },
    },
    optionAsMeta: s.optionAsMeta,
    copyOnSelect: s.copyOnSelect,
    openLinksSingleClick: s.openLinksSingleClick,
    bell: s.bell,
    bellBounceDock: s.bellBounceDock,
    confirmCloseBusy: s.confirmCloseBusy,
  };
}

/**
 * Whether Option is Meta for the Option key just pressed: `code` is the
 * KeyboardEvent.code of that keydown ("AltLeft" or "AltRight"). The
 * terminal sets xterm.js's macOptionIsMeta to this on each Option keydown,
 * so the next key with Option is read with the right side's rule.
 */
export function macOptionIsMetaFor(mode: OptionAsMeta, code: string): boolean {
  if (mode === 'both') return true;
  if (mode === 'left') return code === 'AltLeft';
  if (mode === 'right') return code === 'AltRight';
  return false;
}

// ------------------------------------------------------------ the API

export type SettingsTab = 'appearance' | 'behavior';

/** What `settings:get` answers and `settings:changed` sends (docs/SETTINGS.md). */
export interface SettingsSnapshot {
  settings: Settings;
  /** The shipped themes, then the imported ones. */
  themes: ThemeInfo[];
  /** The system's appearance now. */
  appearance: Appearance;
  /** What the settings make of a terminal now: options for xterm.js and the rest. */
  terminal: TerminalSettings;
}

export type SettingsSetResult = { ok: true; snapshot: SettingsSnapshot } | { ok: false; error: string };

/** window.ravenry.settings in the main window (src/preload/preload.ts). */
export interface SettingsApi {
  get(): Promise<SettingsSnapshot>;
  set(patch: SettingsPatch): Promise<SettingsSetResult>;
  /** Called with a new snapshot after any change: a setting, an imported theme, the system's appearance. Returns the way to stop. */
  onChange(cb: (s: SettingsSnapshot) => void): () => void;
  /** A bell rang in a terminal: the main process plays the sound and bounces the Dock, as the settings say. */
  bell(): void;
  /** Opens the Settings window (or brings it to the front). */
  open(tab?: SettingsTab): void;
}
