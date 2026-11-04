# Changelog

## 0.1.1

- The hand-off no longer waits forever on watches Claude Code keeps for itself: a
  monitor counts as running work only when a Monitor call started it. Pages
  published with the Artifact tool each keep such a watch, and six of them held
  a session past its hand-off line for hours.

## 0.1.0

The first package.

- `npm i -g ravenry-app`, then `ravenry`: starts the board on :4600 and opens it
  (in a cmux browser pane, an iTerm2 tab, or the default browser).
- `ravenry setup`: checks macOS, Node, Claude Code and the terminal, shows the
  two hooks it adds to `~/.claude/settings.json`, and asks first (backup
  before writing). `ravenry doctor` and `ravenry uninstall` (`--purge`).
- Supported terminals: cmux and iTerm2. Sessions in any other terminal are
  watch only, with a one-line suggestion to install iTerm2.
- A new board starts empty: projects appear from their running sessions.
- Rule suggestions (a daily `claude -p` on your own login) are off until
  setup asks.
- Playwright is optional, only for idea mockup pictures.
- Licensed under Apache 2.0 (LICENSE, NOTICE). The name "Ravenry" and its
  logo are trademarks (TRADEMARK.md).
