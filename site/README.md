# The launch page

Ravenry's download page for the early test: one static page, dark, with the
Mac app and the phone drawn large, and the links to the Mac app (DMG) and the
Android app (APK). No build step, no fonts or scripts from elsewhere, no
trackers: it uses the system fonts and the files in this folder only.

| File | What it is |
| --- | --- |
| `index.html` | The page. Its settings block is at the very top (below). |
| `site.css` | The page's look. |
| `product.css`, `product.js` | The product pictures (the Mac app, the phone, the cards), drawn in HTML with demo content only, so they stay sharp at any size. |
| `assets/` | The favicon and Apple touch icon (from `hub/brand/ravenry`) and `og-image.png`, the 1200x630 link preview. |
| `tools/shots.mjs` | The review pictures and the link check (below). Not needed to host the page. |

## The settings

At the top of `index.html`, `window.RAVENRY_SITE`:

- `macVersion`: the Mac app's version on the latest release. The DMG link and
  the "Version" line come from it: `Ravenry-<version>-mac-arm64.dmg`, the name
  `apps/macos/scripts/package.mjs` gives it. Change it with each release.
- `apkFile`: the APK's name, the same on every release (`Ravenry-android.apk`).
- `downloads`: where GitHub serves the latest release's files
  (`.../releases/latest/download/`).
- `reportUrl`: where "report a problem" goes (a new GitHub issue).
- `firstLaunchNote`: `true` shows "Right-click Ravenry and choose Open the
  first time." under the Mac download, for a build not signed with a
  Developer ID. Off by default.

## Preview and check

    open site/index.html                      # the page, as is
    node site/tools/shots.mjs                 # pictures at 1440 and 390 + the check
    node site/tools/shots.mjs --out DIR --og  # pictures in DIR, and a new og-image.png

`shots.mjs` serves this folder on 127.0.0.1, opens it in headless Chromium (the
hub's Playwright: `npm install` in `hub/`), writes `page-<width>.png` and
`hero-<width>.png` for review, and fails on: a request that gets no 200, any
request that leaves the page, a link or asset that does not resolve (anchors
included), a link outside the downloads and the issue link, a script error, or
anything wider than the screen. `--og` remakes `assets/og-image.png` from the
hero.

## Publishing (a person's step)

1. Copy this folder, without `tools/`, to the public repository chosen for
   the page, and turn on GitHub Pages for it (Settings, Pages: deploy from a
   branch, the folder that holds `index.html`).
2. Publish a GitHub release on the repository `downloads` names, with these
   files attached: `Ravenry-<macVersion>-mac-arm64.dmg` (from
   `apps/macos/scripts/package.mjs`) and the release APK, renamed to
   `apkFile`. GitHub's `releases/latest/download/` links always point at the
   newest release, so `macVersion` must match the DMG on it.
3. Once the page has its address, make `og:image` in `index.html` an
   absolute URL (`https://<address>/assets/og-image.png`): link previews need
   one.
