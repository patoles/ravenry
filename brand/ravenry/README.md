# Ravenry mark: Perch

Perch was round-1 candidate B, kept after a second round. The rounds
(`docs/design/Logo.dc.html` and `brand/candidates/`) stay in the private
design record.

The three SVGs are the source of truth, copied unchanged from
`brand/candidates/b-perch*.svg`. Every PNG is rendered from them; regenerate,
never hand-edit:

```sh
node brand/ravenry/build.mjs     # headless Playwright; writes the PNGs here and refreshes public/icons/
```

| File | What it is for |
| --- | --- |
| `icon.svg` | The 1024 app tile: white raven with a blue eye on near-black (#121214), full bleed, the raven inside a centred circle so any system mask (squircle, circle, square) can round it. |
| `favicon.svg` | The small cut for 16 and 32 px: the same drawing, bigger glyph, tile already rounded. The board's SVG favicon. |
| `template.svg` | macOS menu-bar template: black on clear, eye cut out; the system tints it. |
| `icon-1024/512/256/128/64/32/16.png` | The tile from `icon.svg` at each size (app icons, docs). |
| `favicon-32.png`, `favicon-16.png` | PNG favicon fallbacks from `favicon.svg`; `favicon-32.png` is also the iTerm2 "Ravenry board" tab icon. |
| `readme-logo.png` | The 256 tile with its corners rounded in the PNG (22.5%), shown at the top of the README, because GitHub and npm ignore CSS there. |
| `apple-touch-icon-180.png` | Home-screen icon for the phone page (iOS rounds the corners). |
| `template-16.png`, `template-16@2x.png`, `template-32.png`, `template-32@2x.png` | Menu-bar template at 16 and 32 pt, 1x and 2x. |

Where it is used:

- `public/index.html` links `public/icons/` (favicon SVG, the two PNG
  fallbacks, the apple-touch icon). `build.mjs` copies those four there.
- The mark beside "Ravenry" at the board's top left is the template glyph
  drawn inline in `public/index.html` at 20 px, body in the text colour and
  eye in the board's blue, as the round 1 B card's "Board top-left, 14 px
  bold" lockup shows it.
- `tools/open-in-iterm.mjs` sets `favicon-32.png` as the custom icon of the
  "Ravenry board" iTerm2 profile.
