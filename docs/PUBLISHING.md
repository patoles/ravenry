# Publishing the npm package

Not shipped. What the package holds, how to prove it, and what is left
before the first `npm publish`.

## What ships

`package.json` "files" decides: `bin/`, `server/`, `hooks/`, `public/`,
`tools/open-in-iterm.mjs` and `tools/iterm-board-split.py` (the iTerm2 tab
`ravenry` opens), the PNG and SVG icons in `brand/ravenry/` (the iTerm2 tab
icon), and README.md (the user's guide), LICENSE (Apache 2.0), NOTICE and
CHANGELOG.md. No
test, fixture (`tools/fixtures/live` holds real session text), docs, design
mockup, screenshot, `.tmp` or brand candidate. No runtime dependency:
Playwright and jsQR are dev dependencies; the board loads Playwright lazily
for idea mockup pictures only.

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
Playwright; and checks the real `~/.claude/settings.json` and
`~/.ravenry/projects.json` did not change.

## The public repository

The private repo's history holds design mockups drawn from a real board, so
it never becomes public. The public repository starts from a fresh history
with one commit, made by:

```sh
node tools/export-public.mjs <new folder> --commit "Ravenry <version>"
```

It copies only what its ALLOW list names (bin, server, hooks, public, tools,
brand/ravenry, the README, LICENSE, NOTICE, TRADEMARK.md, CONTRIBUTING.md,
CHANGELOG, the public docs and the README's two screenshots) and
nothing its DENY list names (docs/design, docs/shots, tools/fixtures/live,
the repeats seed, tools/private, brand/candidates, tools/phase-d-e2e.mjs),
audits the copy and commits only when the audit is clean (docs/DEVELOPING.md,
Tools). Later releases export again into a clone of the public repo's
working tree, or the public repo becomes the place work happens.

## The README's screenshots

`docs/screenshot.png` and `docs/screenshot-phone.png` are drawn by
`node tools/readme-shot.mjs` from a made-up demo board (docs/DEVELOPING.md,
Tools), never from a real one, so they are on the export's ALLOW list. The
README names them by absolute URL on raw.githubusercontent.com, because npm
shows images only by URL; they render once the public repo has them on
`main`. Redraw them after a visible change to the board.

## Decided for 0.1.0

- The repository is github.com/patoles/ravenry (package.json `repository`,
  `homepage` and `bugs`).
- Author and copyright holder: Simon Patole.
- Licence: Apache-2.0, like Agent Flow: permissive to keep contributors'
  friction low, Apache over MIT for its explicit patent grant. NOTICE ships
  with the package (Apache 2.0, section 4(d)) and credits the vendored uqr.
  TRADEMARK.md keeps the name "Ravenry" and its logo out of the licence.
  CONTRIBUTING.md asks for no contributor licence agreement.

## Before publishing

- Create the public repo (patoles/ravenry) from the exported snapshot and
  push it, so the README's screenshot URLs resolve.
- Check `npm whoami`, then `npm publish` (the owner's call).
