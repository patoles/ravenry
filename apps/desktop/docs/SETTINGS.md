# Terminal settings

The settings the Settings window (Cmd+, on macOS, Ctrl+, on Linux under
Edit) changes, where they live, and the API the main window uses to apply
them to its terminals.

| Where | What |
| --- | --- |
| `src/shared/settings.ts` | The shape, defaults, checks, migrations, `terminalSettings()` (settings to xterm.js options) and `macOptionIsMetaFor()`. Pure. |
| `src/shared/themes.ts`, `shared/themes/*.json` (the repository's), `shared/settings/settings.json` (the keys) | The eight shipped themes. |
| `src/main/settingsstore.ts` | The store on disk. No Electron, so the tests use it as it is. |
| `src/main/themeimport.ts` | `.itermcolors` and Ghostty theme import. Pure. |
| `src/main/settings.ts` | The IPC, and the Settings window. |
| `src/preload/settings-preload.ts`, `src/settings/` | The Settings window's preload and page. |
| `test/settings.test.ts`, `test/themeimport.test.ts` | Unit tests, with samples in `test/fixtures/themes/`. |
| `tools/settings-shots.mjs` | Offscreen screenshots of the window, and of a real xterm.js in Ravenry Light and Ravenry Dark. |

## On disk

`<userData>/settings.json` (on a Mac, `~/Library/Application
Support/Ravenry/settings.json`; `RAVENRY_DESKTOP_DATA` moves it), written
whole and atomically on each change. Nothing is written until something
changes. Imported themes are `<userData>/themes/<slug>.json`.

```json
{
  "version": 1,
  "fontFamily": "Menlo",
  "fontSize": 13,
  "themeFollowsSystem": true,
  "themeDark": "ravenry-dark",
  "themeLight": "ravenry-light",
  "themeAlways": "ravenry-dark",
  "cursorStyle": "block",
  "cursorBlink": false,
  "optionAsMeta": "off",
  "copyOnSelect": false,
  "openLinksSingleClick": false,
  "scrollback": 10000,
  "bell": "visual",
  "bellBounceDock": true,
  "confirmCloseBusy": true
}
```

| Key | Values | Default | Meaning |
| --- | --- | --- | --- |
| `fontFamily` | a family name, no quotes or commas | `Menlo` | The terminal's font. Menlo, SF Mono, DejaVu Sans Mono and Liberation Mono follow it as fallbacks. |
| `fontSize` | whole number, 8 to 32 | 13 | In CSS pixels. |
| `themeFollowsSystem` | boolean | true | Use `themeLight` when the system is light and `themeDark` when it is dark; false: `themeAlways`. |
| `themeDark`, `themeLight`, `themeAlways` | a theme id | `ravenry-dark`, `ravenry-light`, `ravenry-dark` | Built-in ids are plain, imported ones start with `user:`. |
| `cursorStyle` | `block`, `bar`, `underline` | `block` | Programs can still change it (DECSCUSR). |
| `cursorBlink` | boolean | false | |
| `optionAsMeta` | `off`, `left`, `right`, `both` | `off` | Which Option key sends Esc+key. Off is today's behaviour (README, Keys). |
| `copyOnSelect` | boolean | false | Copy the selection as soon as it is made. |
| `openLinksSingleClick` | boolean | false | A link in a terminal opens on a plain click. Off: Cmd+click (Ctrl+click off the Mac) opens it; hovering one says so, and holding Cmd underlines it with a pointer. |
| `scrollback` | whole number, 100 to 100,000 | 10000 | Lines. |
| `bell` | `visual`, `sound`, `off` | `visual` | |
| `bellBounceDock` | boolean | true | Bounce the Dock icon on a bell while Ravenry is not the front app (macOS). Nothing when `bell` is off. |
| `confirmCloseBusy` | boolean | true | Ask before closing a tab whose shell runs something. An idle shell always closes at once. |

**A wrong value in the file** becomes its default; each is named once in
the app's log (`settings: ...`). An unknown key is dropped. **A file that is
not JSON** is kept as `settings.json.broken` and the defaults are used.

**Migrations** (`MIGRATIONS` in `src/shared/settings.ts`): step *i* takes a
file of version *i* to *i* + 1. Before a migrated file is written, the old
one is kept as `settings.v<i>.json`. Version 0 is a file without a version,
using xterm.js's own names: `macOptionIsMeta` (true is `both`), `bellStyle`
(`none` is `off`), `theme` (becomes `themeAlways`, not following the
system), and a CSS font list in `fontFamily` (its first family). **A file
from a newer Ravenry** is read for the keys this version knows, kept as
`settings.v<N>.json`, and only written over when the person changes
something.

To add a setting: add it to `Settings`, `DEFAULTS` and `FIELDS`, and to
`terminalSettings()` if a terminal needs it. A rename or a changed meaning
is a new version: raise `SETTINGS_VERSION` and add a step to `MIGRATIONS`,
with a test.

## The API

In the main window, `window.ravenry.settings` (`src/preload/preload.ts`;
its type is `SettingsApi` in `src/shared/settings.ts`):

```ts
interface SettingsApi {
  get(): Promise<SettingsSnapshot>;
  set(patch: SettingsPatch): Promise<{ ok: true; snapshot: SettingsSnapshot } | { ok: false; error: string }>;
  onChange(cb: (s: SettingsSnapshot) => void): () => void;   // returns the way to stop
  bell(): void;                                               // a bell rang in a terminal
  open(tab?: 'appearance' | 'behavior'): void;                // the Settings window
}

interface SettingsSnapshot {
  settings: Settings;          // the file's values, as above
  themes: ThemeInfo[];         // shipped, then imported: { id, name, appearance, builtIn, credit?, theme: ITheme }
  appearance: 'dark' | 'light';  // the system's now (nativeTheme.shouldUseDarkColors)
  terminal: TerminalSettings;  // what the settings make of a terminal now
}

interface TerminalSettings {
  appearance: 'dark' | 'light';
  themeId: string; themeName: string;
  xterm: {                     // set each on term.options as it is
    fontFamily: string;        // a CSS font list
    fontSize: number;
    cursorStyle: 'block' | 'bar' | 'underline';
    cursorBlink: boolean;
    scrollback: number;
    macOptionIsMeta: boolean;  // true only for "both"
    theme: ITheme;             // the theme for the system's appearance now
  };
  optionAsMeta: 'off' | 'left' | 'right' | 'both';
  copyOnSelect: boolean;
  openLinksSingleClick: boolean;
  bell: 'visual' | 'sound' | 'off';
  bellBounceDock: boolean;
  confirmCloseBusy: boolean;
}
```

`set` changes all of a patch or, when one value is wrong, none of it, and
says which. `onChange` fires after any change from anywhere (the Settings
window, another window's `set`, an imported theme) **and when the system's
appearance changes**, so a terminal that follows `snapshot.terminal` needs
no appearance listener of its own.

The IPC channels behind it, all in `src/main/settings.ts`:

| Channel | Kind | |
| --- | --- | --- |
| `settings:get` | invoke | The snapshot. |
| `settings:set` | invoke (patch) | `{ ok, snapshot }` or `{ ok: false, error }`. |
| `settings:changed` | main to every window | A new snapshot. |
| `settings:bell` | send | Plays the sound (`shell.beep()`) and bounces the Dock, as the settings say. Nothing offscreen. |
| `settings:open` | send (tab?) | Opens the Settings window or brings it to the front. |
| `settings:import-theme` | invoke | The Settings window's Import: a file dialog, then the import. Offscreen, no dialog: the file named by `RAVENRY_SETTINGS_IMPORT`. |
| `settings:window`, `settings:size`, `settings:tab`, `settings:show-tab` | | The Settings window's own: platform and tab, its height, its title. |

## Applying them (the main window's terminals)

```ts
import type { SettingsSnapshot } from '../shared/settings.ts';
import { macOptionIsMetaFor } from '../shared/settings.ts';

let ts: SettingsSnapshot['terminal'];
const apply = (s: SettingsSnapshot) => {
  ts = s.terminal;
  Object.assign(term.options, ts.xterm);   // font, size, cursor, scrollback, theme, macOptionIsMeta
  fit.fit();                               // the cell size changed with the font
};
apply(await window.ravenry.settings.get());
window.ravenry.settings.onChange(apply);
```

- **Option as Meta, left or right.** xterm.js's `macOptionIsMeta` is one
  switch for both keys, and xterm.js reads it on each key. So for `left` and
  `right`, set it on each Option keydown from the side pressed, in the
  custom key handler, before anything else in it:

  ```ts
  if (e.type === 'keydown' && (e.code === 'AltLeft' || e.code === 'AltRight')) {
    term.options.macOptionIsMeta = macOptionIsMetaFor(ts.optionAsMeta, e.code);
  }
  ```

  The Option keydown comes before the key typed with it, so that key is
  read with the right side's rule. `off` and `both` need nothing more
  (`ts.xterm.macOptionIsMeta` is false or true). The handler's MAC_OPT_SEND
  (Option+arrows by word) stays as it is on either side.
- **Copy on select:** on `term.onSelectionChange`, when `ts.copyOnSelect`
  and `term.hasSelection()`, copy `term.getSelection()` (the existing
  `copy-text` IPC).
- **The bell:** on `term.onBell`, when `ts.bell === 'visual'` flash the pane
  (F4 of the terminal-basics picture), and in every case call
  `window.ravenry.settings.bell()`: the main process plays the sound and
  bounces the Dock as the settings say.
- **Closing a busy tab:** ask first (F3) only when `ts.confirmCloseBusy`.
- **Scrollback:** `ts.xterm.scrollback` is xterm.js's. The daemon keeps its
  own scrollback for a pane (10,000 lines today), which a fresh snapshot
  replays; for the Settings hint ("Kept by Ravenry's daemon, so it survives
  a tab switch and a relaunch") to hold beyond 10,000 lines, the daemon's
  limit must follow this setting too. Not wired yet.
- **Font size keys:** Cmd+= and Cmd+- change it for the open terminals:
  `set({ fontSize: ts.xterm.fontSize ± 1 })`, and every window follows
  through `onChange`.

## Themes

Shipped (`shared/themes/<id>.json` at the repository's root, each `{ name, appearance, credit?,
theme }` where `theme` is an xterm.js ITheme): `ravenry-dark` (the
terminal's colours from before settings, `src/renderer/terminal.ts`),
`solarized-dark`, `dracula`, `nord`, `ravenry-light` (F6 of the
terminal-basics picture), `solarized-light`, `github-light`, `paper`. The
third-party palettes are MIT; their credits are in the repository's NOTICE.

**Import** (`src/main/themeimport.ts`), told apart by the text:

- **iTerm2 `.itermcolors`**, a plist XML file: `Ansi 0 Color` to `Ansi 15
  Color`, `Background Color`, `Foreground Color`, and when present `Cursor
  Color`, `Cursor Text Color`, `Selection Color`, `Selected Text Color`.
  iTerm2 3.4's `(Dark)` and `(Light)` variants are read when the plain key is
  missing (the dark one first). Colours saved in Display P3 are converted to
  sRGB; sRGB and Calibrated are taken as they are.
- **Ghostty theme files** (key = value lines, as in Ghostty's `themes/`
  folder): `palette = N=#rrggbb` for 0 to 15 (16 and up are ignored),
  `background`, `foreground`, `cursor-color`, `cursor-text`,
  `selection-background`, `selection-foreground`; colours with or without
  `#`, and the common X11 names.

The name comes from the file's name, the appearance from the background's
luminance (the theme shows under For dark or For light). The same file
imported twice is one theme; another theme with the same name gets
`<slug>-2`. A file with any of the 16 colours, the background or the
foreground missing is refused with the reason, and nothing changes.

## The Settings window

720 px wide, its height following its tab (601 px Appearance, 512 px
Behavior), not resizable. On macOS the title bar is hidden and the page
draws the title and the toolbar tabs, with the system's traffic lights at
14, 12. It has its own session (`ravenry-settings`) so that its page may
list the installed fonts (the Local Font Access API, `local-fonts` granted
there only): the families where i, W and m are the same width, without
hidden system families and symbol fonts. Offscreen (`RAVENRY_OFFSCREEN=1`)
it renders offscreen too, like the main window.

The live preview shows the font, the size, the cursor and the theme in use
now (the dark pick in dark mode, the light pick in light mode).

```sh
node build.mjs && node tools/settings-shots.mjs <outDir>
```
