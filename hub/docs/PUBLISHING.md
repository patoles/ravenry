# Publishing the npm package

Not shipped. What the package holds, how to prove it, and what is left
before the first `npm publish`.

## What ships

`package.json` "files" decides: `bin/`, `server/`, `hooks/`, `public/`,
`tools/open-in-iterm.mjs` and `tools/iterm-board-split.py` (the iTerm2 tab
`ravenry` opens), the PNG and SVG icons in `brand/ravenry/` (the iTerm2 tab
icon), and README.md (the user's guide), LICENSE (GPL-3.0-only), NOTICE and
CHANGELOG.md. No
test, fixture (`tools/fixtures/live` holds real session text), docs, design
mockup, screenshot, `.tmp` or brand candidate. No runtime dependency:
Playwright and jsQR are dev dependencies; the board never loads Playwright
(pictures of pages are drawn by the Mac's Quick Look).

## The proof

```sh
node tools/package-test.mjs --shots <dir> [--keep]
```

Packs the tarball, checks `npm pack --json`'s shape (npm 11 prints an array
of one object; npm 12 changed it, so a mismatch prints the raw output and
fails), the file list, personal paths and the size; installs the TARBALL
with `npm i -g --prefix <scratch>` and a scratch HOME outside this repo;
runs setup, doctor, a stale hook, the board on :4697 with headless shots of
the first run, a hook event through the installed command, and uninstall
(settings.json back to its exact bytes); proves the package resolves no
Playwright and still draws a mockup (Quick Look); and checks the real `~/.claude/settings.json` and
`~/.ravenry/projects.json` did not change.

## The public repository

The hub is developed in the `hub/` folder of the Ravenry monorepo,
github.com/patoles/ravenry, public with its whole history. The
personal-data audit (`node tools/audit.mjs` at the repository root) runs in
CI on every push and pull request. The npm board's own code, 0.4.x and
earlier, is on that repository's `npm-board` branch, with its tags; those
releases were exported from a separate private repository.

## The README's screenshots

`docs/screenshot.png` and `docs/screenshot-phone.png` are drawn by
`node tools/readme-shot.mjs` from a made-up demo board (docs/DEVELOPING.md,
Tools), never from a real one, so they may be committed. The
README names them by absolute URL on raw.githubusercontent.com, because npm
shows images only by URL; they render once the public repo has them on
`main`. Redraw them after a visible change to the board.

## Decided for 0.1.0

- The repository is github.com/patoles/ravenry (package.json `repository`,
  `homepage` and `bugs`).
- Author and copyright holder: Simon Patole.
- Licence for 0.1.0 to 0.4.x: Apache-2.0, like Agent Flow: permissive to
  keep contributors' friction low, Apache over MIT for its explicit patent
  grant. NOTICE ships with the package and credits the vendored uqr.
  TRADEMARK.md keeps the name "Ravenry" and its logo out of the licence.

## Decided for the monorepo

- The hub and the app are GPL-3.0-only, `packages/` is Apache-2.0, and a
  commercial licence is available from the copyright holder (LICENSING.md
  at the repository root). The package's LICENSE and NOTICE live in `hub/`
  so they ship in the tarball.
- Contributions come under the contributor licence agreement (CLA.md at
  the repository root), checked on every pull request.

## Before publishing

- At launch, move this repository's history into the public repo
  (patoles/ravenry) and push it, so the README's screenshot URLs under
  `hub/` resolve.
- Check `npm whoami`, then `npm publish` from `hub/` (the owner's call).
