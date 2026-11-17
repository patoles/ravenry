# The launch page

Ravenry's download page for the early test: one static page, dark, with the
Mac app and the phone drawn large, and the links to the Mac app (DMG) and the
Android app (APK). No build step, no fonts or scripts from elsewhere, no
trackers: it uses the system fonts and the files in this folder only.

| File | What it is |
| --- | --- |
| `index.html` | The page. Its settings block is at the very top (below). |
| `privacy.html` | The privacy policy, linked from the page's footer and from each app's settings. Every claim in it is what the code does: check the source before changing a word, and change its Effective date. Its issue link is the page's `reportUrl`. |
| `site.css` | The page's look. |
| `product.css`, `product.js` | The product pictures. The Mac app and the cards are drawn in HTML with demo content only, so they stay sharp at any size. The phones are the Android app's real screens in a drawn frame: `assets/phone-*.webp`. |
| `assets/` | The favicon and Apple touch icon (from `hub/brand/ravenry`), `og-image.png`, the 1200x630 link preview, and the phone screens: `phone-card.webp` (an alert tapped, the app open on the question), `phone-board.webp` (the same question on the board) and `phone-alerts.webp` (the notification shade). They are emulator screenshots of the Android app paired with a demo board (apps/desktop/tools/demo-hub.mjs, real `ravenry ask`, `approve` and `secret` checkpoints), 600 px wide for 2x screens. |
| `tools/shots.mjs` | The review pictures and the link check (below). Not needed to host the page. |

## The settings

At the top of `index.html`, `window.RAVENRY_SITE`:

- `macVersion`: the Mac app's version on the latest release, the "Version"
  line. `tools/publish-testers.mjs` sets it in the copy it publishes.
- `macFile`: the DMG's name, the same on every release (`Ravenry-mac.dmg`,
  which `apps/macos/scripts/package.mjs` writes beside the versioned one), so
  the link never breaks on a new version.
- `apkFile`: the APK's name, the same on every release (`Ravenry-android.apk`).
- `downloads`: where GitHub serves the latest release's files
  (`.../releases/latest/download/`).
- `reportUrl`: where "report a problem" goes (a new GitHub issue).
- `sourceUrl`: the source code on GitHub, the footer's link.
- `firstLaunchNote`: `true` shows "The first time, macOS asks: open System
  Settings, Privacy & Security, and choose Open Anyway." under the Mac
  download, for a build not signed with a Developer ID. Off since 0.1.65:
  releases are signed with a Developer ID, notarized and stapled
  (`docs/PUBLISHING.md`).

## Preview and check

    open site/index.html                      # the page, as is
    node site/tools/shots.mjs                 # pictures at 1440 and 390 + the check
    node site/tools/shots.mjs --out DIR --og  # pictures in DIR, and a new og-image.png

`shots.mjs` serves this folder on 127.0.0.1, opens it in headless Chromium (the
hub's Playwright: `npm install` in `hub/`), writes `page-<width>.png` and
`hero-<width>.png` for review, and `privacy-<width>.png` for the privacy page, and fails on: a request that gets no 200, any
request that leaves the page, a link or asset that does not resolve (anchors
included), a link outside the downloads and the issue link, a script error, or
anything wider than the screen. `--og` remakes `assets/og-image.png` from the
hero.

## Publishing (a person's step)

`node tools/publish-testers.mjs` (a dry run; `--yes` does it) publishes this
folder, without `tools/` and this README, to the `gh-pages` branch of the public repository
(the root package.json's `ravenry.releases`, the one `downloads` names), with
`macVersion` set to the release's version and `og:image` made absolute (link
previews need one), and makes the release whose files `downloads` names:
`macFile` and `apkFile` among them. GitHub's `releases/latest/download/`
links always point at the newest release. `--page-only` publishes this
folder alone, between releases, for the release already marked latest. The
steps: `docs/PUBLISHING.md`.
