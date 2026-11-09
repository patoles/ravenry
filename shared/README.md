# Shared words and design tokens

What every Ravenry client draws with, kept once here so no client types it
again: the Electron desktop app, the phone board, the hub, the native Mac
app and later Linux and Windows. Two JSON files, read as they are; a client
in another language (Swift, Kotlin) reads the same files, at build time or
at launch.

| File | What |
| --- | --- |
| `strings/en.json` | the words, one key each |
| `tokens/tokens.json` | colours for dark and light, shadows, fonts, type sizes, line heights, radii, spacing |
| `tokens/css.mjs` | `tokens.json` as CSS variables, for the web clients' builds |
| `icons/*.svg` | the icons, one file each, written from the desktop's `icons.ts` by `icons/export.mjs` |

## strings/en.json

A flat JSON object: each key maps to one string. `$comment` is the only
key that is not a string to show.

- **Keys** are dotted lowerCamel words, the area first: `group.you`,
  `session.handOffNow`, `checkpoint.secretSend`. A key keeps its meaning:
  new words that say something else get a new key.
- **Placeholders** are `{name}`: letters, digits and `_` between braces.
  The client puts in the value as text. A placeholder without a value stays
  as it is, and a key the file does not have is shown as the key itself, so
  a missing word is seen, never blank.
- **Text** is plain UTF-8, no markup, no em dashes.
- One file per language, `<code>.json` (`en.json` today). A language other
  than English has the same keys.

The section titles of the sidebar are `group.you` ("Needs you"),
`group.work` ("Working"), `group.wait` ("Waiting on others") and
`group.idle` ("Idle").

Readers today: `t(key, vars)` in `apps/desktop/src/shared/strings.ts`,
`apps/phone/src/strings.ts` and `hub/server/strings.mjs`. A Swift reader:

```swift
let words = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
func t(_ key: String, _ vars: [String: String] = [:]) -> String {
    guard let s = words[key] as? String, key != "$comment" else { return key }
    return vars.reduce(s) { $0.replacingOccurrences(of: "{\($1.key)}", with: $1.value) }
}
```

## tokens/tokens.json

```json
{
  "version": 1,
  "color":  { "dark": { "win": "#161618", "you-t": "rgba(255,159,10,.11)", ... }, "light": { ... } },
  "shadow": { "dark": { "shadow": "0 1px 0 rgba(255,255,255,.03) inset", ... }, "light": { ... } },
  "font": { "ui": ["-apple-system", ...], "mono": ["ui-monospace", ...] },
  "size": { "2xs": 11, ..., "base": 13, ... },
  "lineHeight": { "base": 1.4, "mono": 1.5 },
  "radius": { "xs": 3, ... },
  "space": { "2xs": 2, ... }
}
```

- **Colours** come in two forms only: `#RRGGBB` (six hex digits, upper case,
  opaque) and `rgba(R,G,B,A)` with R, G and B from 0 to 255 and A from 0
  to 1 (`.11` is 0.11), sRGB. Both themes have the same keys, in the same
  order. Dark is the default; light is what the system's light appearance
  uses. The terminal stays dark in both (`term-bg`).
- **The colour keys:** the window `win`; the sheets `sheet`, `sheet-ring`,
  `card`, `card2`, `sep`; text `tx`, `tx2`, `tx3`; the four states `you`,
  `work`, `wait`, `idle` and their tints `you-t`, `work-t`, `wait-t`,
  `idle-t`; `ok`, `bad` and their tints; the selection `sel`, `selring`;
  buttons `btn`, `btn-tx`; `input`, `link`, `term-bg`, `chg` (a change
  marked), `tile`, `lane-cnt`; the agents `claude`, `codex` and their tints,
  `amber-t`.
- **Shadows** are CSS `box-shadow` values: `x y blur spread colour`, an
  optional `inset`, lengths in pixels. `tile-ring` is a 1 pixel ring
  (spread 1) in light and none in dark.
- **Fonts** are lists in order of preference; the first one the platform
  has is used.
- **Numbers** (`size`, `radius`, `space`) are CSS pixels, which are points
  on macOS and iOS and dp on Android. Line heights are multiples of the
  font size, with no unit.
- `version` changes only when the shape changes, not when a value does.

### In CSS

`tokens/css.mjs` writes the variables (dark under `:root`, light under
`@media (prefers-color-scheme: light)`): a colour or a shadow is
`--<key>` (`--win`, `--tx3`, `--you-t`, `--shadow`), a font `--font-<key>`,
a size `--fs-<key>`, a line height `--lh-<key>`, a radius `--radius-<key>`,
a spacing `--space-<key>`. The desktop's build (`apps/desktop/build.mjs`)
gives it to `app.css` and `settings.css` as `@import "ravenry-tokens.css"`;
the phone's (`apps/phone/build.mjs`) puts it first in its `app.css`. No
stylesheet declares a token's variable itself
(`apps/desktop/test/shared.test.ts` checks it, and that the generated CSS
says exactly what `tokens.json` says).

### In Swift

Decode with `JSONDecoder` into dictionaries (`[String: String]` for each
theme's colours, `[String: Double]` for the scales). A colour: `#RRGGBB`
is `NSColor(srgbRed: r/255, green: g/255, blue: b/255, alpha: 1)`;
`rgba(r,g,b,a)` is the same with `alpha: a`. Pick the theme from
`NSApp.effectiveAppearance` (dark or aqua).

## icons/

One SVG per icon, written from `apps/desktop/src/renderer/icons.ts` (the
one source) by `node --experimental-strip-types shared/icons/export.mjs`;
`--check` exits 1 when a file differs from it. A constant is
`<name>.svg` in kebab case (`RING_YOU`: `ring-you.svg`), a function is
called with its defaults, the `NAV` object gives `nav-<page>.svg`, and
`machines.svg` is `MACHINES_ICON` of `machines.ts`. Colours are left as the
desktop writes them: `currentColor` (the reader puts the colour it draws
with) and `var(--token)` (the token's colour of `tokens.json` for the
theme). The native Mac app bundles the folder and draws them with
`NSImage(data:)` after filling the colours (`apps/macos/.../Shared.swift`).

## Where they ship

The desktop and phone builds read both files from here at build time; the
native Mac app bundles `tokens.json`, `en.json` and `icons/` and reads them
at launch. The
hub reads `strings/en.json` at run time (`hub/server/strings.mjs`): from
`hub/shared/` inside the app (`apps/desktop/scripts/pack.mjs` copies this
folder there), else from `../../shared/` in the repository.
